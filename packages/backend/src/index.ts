import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import { createBot, startBot } from './telegram/bot.js';
import { prisma, createUser, getAllUsers, getOrCreateSession, clearSession, getUserByTelegramId } from './state/db.js';
import { getHyperliquidClient, TRADING_ASSET } from './hyperliquid/client.js';
import {
  verifyPrivyToken,
  RegistrationRequestSchema,
  validateTelegramInitData,
  extractTelegramUserId,
} from './privy/verify.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'webhook-secret';
const MINIAPP_URL = process.env.MINIAPP_URL || '';

// Gas drip configuration
const GAS_FUNDER_PRIVATE_KEY = process.env.GAS_FUNDER_PRIVATE_KEY || '';
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const GAS_DRIP_AMOUNT = ethers.parseEther('0.00005'); // ~$0.15 at $3000/ETH - enough for ~2-3 txs
const MIN_GAS_BALANCE = ethers.parseEther('0.00002'); // Minimum ETH to skip drip

async function main() {
  console.log('[Server] Starting GOLD Trading Bot...');

  // Initialize Hyperliquid client
  try {
    await getHyperliquidClient();
    console.log('[Hyperliquid] Client initialized');
  } catch (error) {
    console.error('[Hyperliquid] Failed to initialize:', error);
    process.exit(1);
  }

  // Create Express app
  const app = express();

  // Trust proxy (required for Railway/cloud deployments behind reverse proxy)
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet());

  // CORS - allow miniapp to call API
  const corsOrigins = [
    MINIAPP_URL,
    'https://miniapp-production-45a0.up.railway.app',
    'https://web.telegram.org',
  ].filter(Boolean);
  
  app.use(cors({
    origin: corsOrigins.length > 0 ? corsOrigins : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data'],
    credentials: true,
  }));

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // Stricter rate limit for registration
  const registrationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5, // 5 registrations per minute
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Parse JSON for most routes
  app.use(express.json({ limit: '10kb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GOLD price endpoint (public)
  app.get('/api/price', async (req, res) => {
    try {
      const hl = await getHyperliquidClient();
      const price = await hl.getGoldPrice();
      res.json({ coin: 'GOLD', price, timestamp: Date.now() });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch price' });
    }
  });

  // Registration endpoint (from Mini App)
  app.post('/api/register', registrationLimiter, async (req: Request, res: Response) => {
    try {
      // Validate request body
      const parsed = RegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
        return;
      }

      const { privyToken, telegramUserId, agentAddress, agentPrivateKey } = parsed.data;

      // Verify Privy token
      const privyUser = await verifyPrivyToken(privyToken);

      // Validate Telegram init data if provided
      const initData = req.headers['x-telegram-init-data'] as string | undefined;
      if (initData) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken && !validateTelegramInitData(initData, botToken)) {
          res.status(401).json({ error: 'Invalid Telegram authentication' });
          return;
        }

        // Verify Telegram user ID matches
        const extractedId = extractTelegramUserId(initData);
        if (extractedId && extractedId !== telegramUserId) {
          res.status(401).json({ error: 'Telegram user ID mismatch' });
          return;
        }
      }

      // Ensure private key has 0x prefix for consistency
      const keyWithPrefix = agentPrivateKey.startsWith('0x') ? agentPrivateKey : '0x' + agentPrivateKey;

      // Validate that the private key produces the claimed address
      const derivedAddress = ethers.computeAddress(keyWithPrefix);
      if (derivedAddress.toLowerCase() !== agentAddress.toLowerCase()) {
        console.error(`[Register] Key/address mismatch: claimed=${agentAddress}, derived=${derivedAddress}`);
        res.status(400).json({ error: 'Agent key/address mismatch' });
        return;
      }

      // Create user in database (store key WITH 0x prefix)
      const user = await createUser({
        telegramId: BigInt(telegramUserId),
        privyUserId: privyUser.privyUserId,
        walletAddress: privyUser.walletAddress,
        agentAddress: agentAddress,
        agentPrivateKey: keyWithPrefix,
      });

      console.log(`[Register] User ${telegramUserId} registered with wallet ${privyUser.walletAddress}`);

      res.json({
        success: true,
        telegramId: user.telegramId.toString(),
        walletAddress: user.walletAddress,
      });
    } catch (error) {
      console.error('[Register] Error:', error);

      if (error instanceof Error && error.message.includes('Unique constraint')) {
        res.status(409).json({ error: 'User already registered' });
        return;
      }

      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Gas drip endpoint - sends small amount of ETH for gas
  app.post('/api/gas-drip', registrationLimiter, async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;

      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        res.status(400).json({ error: 'Invalid wallet address' });
        return;
      }

      if (!GAS_FUNDER_PRIVATE_KEY) {
        res.status(503).json({ error: 'Gas drip not configured' });
        return;
      }

      // Check current balance
      const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
      const currentBalance = await provider.getBalance(walletAddress);

      if (currentBalance >= MIN_GAS_BALANCE) {
        console.log(`[GasDrip] User ${walletAddress} already has ${ethers.formatEther(currentBalance)} ETH, skipping`);
        res.json({ 
          success: true, 
          skipped: true, 
          message: 'Sufficient gas balance',
          balance: ethers.formatEther(currentBalance)
        });
        return;
      }

      // Create funder wallet
      const funderWallet = new ethers.Wallet(GAS_FUNDER_PRIVATE_KEY, provider);
      
      // Check funder balance
      const funderBalance = await provider.getBalance(funderWallet.address);
      if (funderBalance < GAS_DRIP_AMOUNT) {
        console.error(`[GasDrip] Funder wallet ${funderWallet.address} has insufficient balance: ${ethers.formatEther(funderBalance)}`);
        res.status(503).json({ error: 'Gas funder depleted' });
        return;
      }

      // Send gas drip
      console.log(`[GasDrip] Sending ${ethers.formatEther(GAS_DRIP_AMOUNT)} ETH to ${walletAddress}`);
      
      const tx = await funderWallet.sendTransaction({
        to: walletAddress,
        value: GAS_DRIP_AMOUNT,
      });

      console.log(`[GasDrip] Transaction sent: ${tx.hash}`);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      
      console.log(`[GasDrip] Transaction confirmed in block ${receipt?.blockNumber}`);

      res.json({
        success: true,
        txHash: tx.hash,
        amount: ethers.formatEther(GAS_DRIP_AMOUNT),
      });
    } catch (error) {
      console.error('[GasDrip] Error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Gas drip failed: ${message}` });
    }
  });

  // Create Telegram bot
  const bot = createBot();

  // Telegram webhook endpoint
  app.post(`/telegram/${WEBHOOK_SECRET}`, express.json(), (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  // Auth completion webhook - called by Mini App after successful agent authorization
  app.post('/api/auth-complete', registrationLimiter, async (req: Request, res: Response) => {
    try {
      const { telegramUserId } = req.body;
      
      if (!telegramUserId) {
        res.status(400).json({ error: 'Missing telegramUserId' });
        return;
      }

      const telegramId = BigInt(telegramUserId);
      const user = await getUserByTelegramId(telegramId);
      
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Check for pending order
      const session = await getOrCreateSession(telegramId);
      
      if (!session.pendingOrder) {
        res.json({ success: true, orderExecuted: false });
        return;
      }

      const { pendingOrder } = session;
      
      console.log(`[AuthComplete] Executing pending order for user ${telegramUserId}:`, pendingOrder);

      try {
        const hl = await getHyperliquidClient();
        
        const result = await hl.placeOrder(user.agentPrivateKey, user.walletAddress, {
          side: pendingOrder.side,
          sizeUsd: pendingOrder.sizeUsd,
          leverage: pendingOrder.leverage,
          orderType: pendingOrder.orderType,
          limitPrice: pendingOrder.limitPrice,
        });

        // Clear the session
        await clearSession(telegramId);

        if (result.status === 'ok') {
          const response = result.response?.data?.statuses[0];
          let orderMessage = '✅ *Order Executed*\n\nYour pending order was placed successfully after authorization.';
          
          if (response?.filled) {
            orderMessage = `✅ *Order Filled*\n\n` +
              `${pendingOrder.side.toUpperCase()} ${response.filled.totalSz} ${TRADING_ASSET}\n` +
              `Avg Price: $${response.filled.avgPx}`;
          } else if (response?.resting) {
            orderMessage = `📝 *Order Placed*\n\nOrder ID: #${response.resting.oid}`;
          } else if (response?.error) {
            orderMessage = `❌ Order rejected: ${response.error}`;
          }

          // Send notification to user
          await bot.telegram.sendMessage(Number(telegramId), orderMessage, { parse_mode: 'Markdown' });
          
          res.json({ success: true, orderExecuted: true, result });
        } else {
          const errorMsg = result.error || 'Unknown error';
          await bot.telegram.sendMessage(
            Number(telegramId),
            `❌ Failed to execute pending order: ${errorMsg}`,
            { parse_mode: 'Markdown' }
          );
          res.json({ success: false, error: errorMsg });
        }
      } catch (orderError) {
        const errorMsg = orderError instanceof Error ? orderError.message : 'Unknown error';
        console.error('[AuthComplete] Order execution failed:', orderError);
        
        await bot.telegram.sendMessage(
          Number(telegramId),
          `❌ Failed to execute pending order: ${errorMsg}`,
          { parse_mode: 'Markdown' }
        );
        
        res.json({ success: false, error: errorMsg });
      }
    } catch (error) {
      console.error('[AuthComplete] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('[Server] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`[Server] Listening on port ${PORT}`);
  });

  // Start bot
  if (NODE_ENV === 'production') {
    const webhookUrl = process.env.BACKEND_URL;
    if (webhookUrl) {
      await startBot(bot, webhookUrl);
    } else {
      console.warn('[Bot] BACKEND_URL not set, using polling in production');
      await startBot(bot);
    }
  } else {
    await startBot(bot);
  }

  // Hourly (6h) position updates
  const POSITION_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let positionUpdateRunning = false;
  const LIQUIDATION_ALERT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const LIQUIDATION_THRESHOLD = 0.05; // 5% to liquidation price
  const LIQUIDATION_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
  const lastLiquidationAlert = new Map<string, number>();

  async function sendPositionUpdates() {
    if (positionUpdateRunning) return;
    positionUpdateRunning = true;

    try {
      const hl = await getHyperliquidClient();
      const users = await getAllUsers();

      for (const user of users) {
        try {
          const position = await hl.getGoldPosition(user.walletAddress);
          if (!position || parseFloat(position.position.szi) === 0) {
            continue;
          }

          const side = parseFloat(position.position.szi) > 0 ? 'LONG' : 'SHORT';
          const size = Math.abs(parseFloat(position.position.szi)).toFixed(4);
          const entry = parseFloat(position.position.entryPx || '0').toFixed(2);
          const pnl = parseFloat(position.position.unrealizedPnl || '0').toFixed(2);
          const leverage = position.position.leverage?.value ?? 0;
          const liq = position.position.liquidationPx ? parseFloat(position.position.liquidationPx).toFixed(2) : 'N/A';
          const price = await hl.getGoldPrice();

          const message =
            `📊 *${TRADING_ASSET} Position Update*\n\n` +
            `📈 *${side}* ${size} ${TRADING_ASSET}\n` +
            `💵 Entry: $${entry}\n` +
            `⚖️ Leverage: ${leverage}x\n` +
            `🟢 PnL: $${pnl}\n` +
            `⚠️ Liquidation: $${liq}\n` +
            `💲 Price: $${price.toFixed(2)}`;

          await bot.telegram.sendMessage(Number(user.telegramId), message, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error('[Notifs] Failed for user', user.telegramId.toString(), err);
        }
      }
    } finally {
      positionUpdateRunning = false;
    }
  }

  setInterval(sendPositionUpdates, POSITION_UPDATE_INTERVAL_MS);

  async function sendLiquidationAlerts() {
    try {
      const hl = await getHyperliquidClient();
      const users = await getAllUsers();

      for (const user of users) {
        try {
          const position = await hl.getGoldPosition(user.walletAddress);
          if (!position || parseFloat(position.position.szi) === 0) {
            continue;
          }

          const liqPxRaw = position.position.liquidationPx;
          if (!liqPxRaw) {
            continue;
          }

          const liqPx = parseFloat(liqPxRaw);
          const price = await hl.getGoldPrice();
          const distance = Math.abs(price - liqPx) / liqPx;

          if (distance > LIQUIDATION_THRESHOLD) {
            continue;
          }

          const key = user.telegramId.toString();
          const lastSent = lastLiquidationAlert.get(key) || 0;
          if (Date.now() - lastSent < LIQUIDATION_ALERT_COOLDOWN_MS) {
            continue;
          }

          lastLiquidationAlert.set(key, Date.now());

          const side = parseFloat(position.position.szi) > 0 ? 'LONG' : 'SHORT';
          const size = Math.abs(parseFloat(position.position.szi)).toFixed(4);
          const leverage = position.position.leverage?.value ?? 0;

          const message =
            `⚠️ *Liquidation Alert (${TRADING_ASSET})*\n\n` +
            `📈 *${side}* ${size} ${TRADING_ASSET}\n` +
            `⚖️ Leverage: ${leverage}x\n` +
            `💲 Price: $${price.toFixed(2)}\n` +
            `🧨 Liq: $${liqPx.toFixed(2)}\n\n` +
            `Top up collateral from /balance.`;

          await bot.telegram.sendMessage(Number(user.telegramId), message, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error('[Notifs] Liquidation alert failed for user', user.telegramId.toString(), err);
        }
      }
    } catch (err) {
      console.error('[Notifs] Liquidation alert job failed', err);
    }
  }

  setInterval(sendLiquidationAlerts, LIQUIDATION_ALERT_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    bot.stop('SIGTERM');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});

