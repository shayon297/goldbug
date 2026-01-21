import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createBot, startBot } from './telegram/bot.js';
import { prisma, createUser } from './state/db.js';
import { getHyperliquidClient } from './hyperliquid/client.js';
import {
  verifyPrivyToken,
  RegistrationRequestSchema,
  validateTelegramInitData,
  extractTelegramUserId,
} from './privy/verify.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'webhook-secret';

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

      // Create user in database
      const user = await createUser({
        telegramId: BigInt(telegramUserId),
        privyUserId: privyUser.privyUserId,
        walletAddress: privyUser.walletAddress,
        agentAddress: agentAddress,
        agentPrivateKey: agentPrivateKey.startsWith('0x')
          ? agentPrivateKey.slice(2)
          : agentPrivateKey,
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

  // Create Telegram bot
  const bot = createBot();

  // Telegram webhook endpoint
  app.post(`/telegram/${WEBHOOK_SECRET}`, express.json(), (req, res) => {
    bot.handleUpdate(req.body, res);
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

