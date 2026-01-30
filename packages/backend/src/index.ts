import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ethers } from 'ethers';
import { createBot, startBot } from './telegram/bot.js';
import { startChartScheduler } from './services/scheduler.js';
import { prisma, createUser, getAllUsers, getOrCreateSession, clearSession, getUserByTelegramId, getLeaderboard } from './state/db.js';
import { getHyperliquidClient, TRADING_ASSET } from './hyperliquid/client.js';
import {
  verifyPrivyToken,
  RegistrationRequestSchema,
  validateTelegramInitData,
  extractTelegramUserId,
} from './privy/verify.js';
import { trackEvent, EVENT_TYPES } from './state/analytics.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'webhook-secret';
const MINIAPP_URL = process.env.MINIAPP_URL || '';
const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS || '';
const BUILDER_MAX_FEE_RATE = process.env.BUILDER_MAX_FEE_RATE || '0.1%'; // Max for perps
// Match Python SDK: signatureChainId = 0x66eee for ALL user-signed actions
const BUILDER_SIGNATURE_CHAIN_ID = '0x66eee'; // 421614 - used by Hyperliquid SDK
const BUILDER_DOMAIN_CHAIN_ID = 421614; // parseInt('0x66eee', 16)

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

  // Onramper webhook - receives notifications when users complete purchases
  const ONRAMPER_WEBHOOK_SECRET = process.env.ONRAMPER_WEBHOOK_SECRET || '';
  
  app.post('/api/webhooks/onramper', async (req: Request, res: Response) => {
    try {
      // Log the webhook for debugging
      console.log('[Onramper Webhook] Received:', JSON.stringify(req.body, null, 2));
      
      const { type, payload } = req.body;
      
      // Handle different event types
      if (type === 'transaction_completed' || type === 'TRANSACTION_COMPLETED') {
        const { walletAddress, cryptoAmount, cryptoCurrency, fiatAmount, fiatCurrency, txId } = payload || {};
        
        console.log(`[Onramper] Transaction completed: ${fiatAmount} ${fiatCurrency} → ${cryptoAmount} ${cryptoCurrency} to ${walletAddress}`);
        
        // Find user by wallet address and notify them with bridge prompt
        if (walletAddress) {
          const user = await prisma.user.findFirst({
            where: { walletAddress: walletAddress.toLowerCase() },
          });
          
          if (user) {
            try {
              // Send notification with bridge button
              await bot.telegram.sendMessage(
                Number(user.telegramId),
                `✅ *USDC Purchase Complete!*\n\n` +
                `💵 You bought: ${cryptoAmount} ${cryptoCurrency}\n` +
                `💳 Paid: ${fiatAmount} ${fiatCurrency}\n\n` +
                `Your USDC is now on Arbitrum.\n` +
                `👇 *Bridge to Hyperliquid to start trading:*`,
                { 
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '🌉 Bridge Now', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
                      [{ text: '📈 Long', callback_data: 'action:long' }, { text: '📉 Short', callback_data: 'action:short' }],
                    ],
                  },
                }
              );
            } catch (err) {
              console.error('[Onramper] Failed to notify user:', err);
            }
          }
        }
      }
      
      // Always respond 200 to acknowledge receipt
      res.status(200).json({ received: true });
    } catch (error) {
      console.error('[Onramper Webhook] Error:', error);
      // Still return 200 to prevent retries
      res.status(200).json({ received: true, error: 'Processing failed' });
    }
  });

  // Generate signed Onramper URL
  const ONRAMPER_SIGNING_SECRET = process.env.ONRAMPER_SIGNING_SECRET || '';
  const ONRAMPER_API_KEY = process.env.ONRAMPER_API_KEY || '';
  
  app.get('/api/onramper-url', async (req: Request, res: Response) => {
    try {
      const { walletAddress, mode, skipSign } = req.query;
      
      if (!walletAddress || typeof walletAddress !== 'string') {
        res.status(400).json({ error: 'walletAddress is required' });
        return;
      }
      
      const onrampMode = mode === 'sell' ? 'sell' : 'buy';
      
      // Build the base URL with parameters
      // See: https://docs.onramper.com/docs/supported-widget-parameters
      const params = new URLSearchParams({
        apiKey: ONRAMPER_API_KEY,
        mode: onrampMode,
        defaultCrypto: 'usdc_arbitrum',
        onlyCryptos: 'usdc_arbitrum',
        onlyNetworks: 'arbitrum',
        networkWallets: `arbitrum:${walletAddress}`,
        walletAddressLocked: 'true',
        themeName: 'dark',
        containerColor: '18181bff',
        primaryColor: 'f59e0bff',
        secondaryColor: '3f3f46ff',
        cardColor: '27272aff',
        primaryTextColor: 'ffffffff',
        secondaryTextColor: 'a1a1aaff',
        borderRadius: '0.75',
      });
      
      const baseUrl = `https://buy.onramper.com/?${params.toString()}`;
      
      // According to Onramper docs (https://docs.onramper.com/docs/signing-widget-url):
      // Widget URL signing is OPTIONAL unless you enable "Signature required" in dashboard
      // 
      // IMPORTANT: If you're getting "Signature validation failed", check your Onramper
      // dashboard settings and disable "Signature required" OR ensure the signing
      // secret matches exactly.
      //
      // For now, we're NOT signing the URL since it's causing issues.
      // The widget should work without signatures for most configurations.
      
      console.log('[Onramper] Generated URL for wallet:', walletAddress);
      console.log('[Onramper] Mode:', onrampMode);
      res.json({ url: baseUrl, signed: false });
    } catch (error) {
      console.error('[Onramper URL] Error:', error);
      res.status(500).json({ error: 'Failed to generate Onramper URL' });
    }
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

  // Leaderboard endpoint (public)
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const hl = await getHyperliquidClient();
      const users = await getLeaderboard(50);
      
      // Fetch volume and PnL data from Hyperliquid for each user
      const leaderboardData = await Promise.all(
        users.map(async (user, index) => {
          try {
            // Get user fills to calculate volume
            const fills = await hl.getUserFills(user.walletAddress);
            const totalVolume = fills.reduce((sum, fill) => {
              const px = parseFloat(fill.px);
              const sz = parseFloat(fill.sz);
              return sum + (px * sz);
            }, 0);

            // Get current position for unrealized PnL
            const position = await hl.getGoldPosition(user.walletAddress);
            const unrealizedPnl = position ? parseFloat(position.position.unrealizedPnl || '0') : 0;

            // Calculate realized PnL from fills (closedPnl may not always be present)
            const realizedPnl = fills.reduce((sum, fill) => {
              const fillAny = fill as any;
              return sum + parseFloat(fillAny.closedPnl || '0');
            }, 0);

            return {
              rank: index + 1,
              wallet: user.walletAddress,
              volume: Math.round(totalVolume * 100) / 100,
              pnl: Math.round((unrealizedPnl + realizedPnl) * 100) / 100,
              points: user.points,
            };
          } catch (err) {
            console.error(`[Leaderboard] Error fetching data for ${user.walletAddress}:`, err);
            return {
              rank: index + 1,
              wallet: user.walletAddress,
              volume: 0,
              pnl: 0,
              points: user.points,
            };
          }
        })
      );

      // Sort by volume (primary) and re-rank
      leaderboardData.sort((a, b) => b.volume - a.volume);
      leaderboardData.forEach((entry, i) => {
        entry.rank = i + 1;
      });

      res.json({
        leaderboard: leaderboardData,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[Leaderboard] Error:', error);
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // Get user wallet by Telegram ID (for Mini App to check existing user)
  app.get('/api/user/:telegramId', async (req, res) => {
    try {
      const telegramId = BigInt(req.params.telegramId);
      const user = await getUserByTelegramId(telegramId);
      
      if (!user) {
        res.status(404).json({ exists: false });
        return;
      }

      res.json({
        exists: true,
        walletAddress: user.walletAddress,
        points: user.points,
      });
    } catch (error) {
      console.error('[User] Error fetching user:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // =====================
  // Analytics API Endpoints (protected with API key)
  // =====================
  const ANALYTICS_API_KEY = process.env.ANALYTICS_API_KEY || 'goldbug-analytics-secret';
  
  const analyticsAuth = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (apiKey !== ANALYTICS_API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  // Analytics Overview - summary metrics
  app.get('/api/analytics/overview', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      const monthStart = new Date(todayStart);
      monthStart.setDate(monthStart.getDate() - 30);

      // User counts
      const [totalUsers, usersToday, usersThisWeek, usersThisMonth] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
        prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
        prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
      ]);

      // Event counts
      const [signups, trades, firstTrades, sessions] = await Promise.all([
        prisma.analyticsEvent.count({ where: { eventType: 'signup', createdAt: { gte: monthStart } } }),
        prisma.analyticsEvent.count({ where: { eventType: 'trade_executed', createdAt: { gte: monthStart } } }),
        prisma.analyticsEvent.count({ where: { eventType: 'first_trade', createdAt: { gte: monthStart } } }),
        prisma.analyticsEvent.count({ where: { eventType: 'session_start', createdAt: { gte: monthStart } } }),
      ]);

      // Calculate conversion rate
      const conversionRate = totalUsers > 0 ? (firstTrades / signups) * 100 : 0;

      res.json({
        users: {
          total: totalUsers,
          today: usersToday,
          thisWeek: usersThisWeek,
          thisMonth: usersThisMonth,
        },
        activity: {
          signups,
          trades,
          firstTrades,
          sessions,
          conversionRate: Math.round(conversionRate * 100) / 100,
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[Analytics] Overview error:', error);
      res.status(500).json({ error: 'Failed to fetch analytics overview' });
    }
  });

  // Analytics Users - user growth over time
  app.get('/api/analytics/users', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get all users created in the period
      const users = await prisma.user.findMany({
        where: { createdAt: { gte: startDate } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      // Group by date
      const dailyCounts: Record<string, number> = {};
      for (let i = 0; i <= days; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        dailyCounts[d.toISOString().split('T')[0]] = 0;
      }

      users.forEach(u => {
        const dateStr = u.createdAt.toISOString().split('T')[0];
        if (dailyCounts[dateStr] !== undefined) {
          dailyCounts[dateStr]++;
        }
      });

      // Calculate cumulative
      let cumulative = await prisma.user.count({ where: { createdAt: { lt: startDate } } });
      const data = Object.entries(dailyCounts).map(([date, count]) => {
        cumulative += count;
        return { date, newUsers: count, totalUsers: cumulative };
      });

      res.json({ data, timestamp: Date.now() });
    } catch (error) {
      console.error('[Analytics] Users error:', error);
      res.status(500).json({ error: 'Failed to fetch user analytics' });
    }
  });

  // Analytics Retention - cohort analysis
  app.get('/api/analytics/retention', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const weeks = parseInt(req.query.weeks as string) || 8;
      const now = new Date();
      
      const cohorts: Array<{
        cohortWeek: string;
        cohortSize: number;
        retention: number[];
      }> = [];

      for (let w = weeks - 1; w >= 0; w--) {
        const cohortStart = new Date(now);
        cohortStart.setDate(cohortStart.getDate() - (w + 1) * 7);
        const cohortEnd = new Date(cohortStart);
        cohortEnd.setDate(cohortEnd.getDate() + 7);

        // Users who signed up in this week
        const cohortUsers = await prisma.user.findMany({
          where: {
            createdAt: {
              gte: cohortStart,
              lt: cohortEnd,
            },
          },
          select: { telegramId: true, createdAt: true },
        });

        const cohortSize = cohortUsers.length;
        if (cohortSize === 0) {
          cohorts.push({
            cohortWeek: cohortStart.toISOString().split('T')[0],
            cohortSize: 0,
            retention: [],
          });
          continue;
        }

        const telegramIds = cohortUsers.map(u => u.telegramId);
        const retention: number[] = [];

        // Check retention for each subsequent week
        for (let retentionWeek = 0; retentionWeek <= w; retentionWeek++) {
          const weekStart = new Date(cohortEnd);
          weekStart.setDate(weekStart.getDate() + retentionWeek * 7);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 7);

          // Count users who had any session in this week
          const activeCount = await prisma.analyticsEvent.groupBy({
            by: ['telegramId'],
            where: {
              telegramId: { in: telegramIds },
              eventType: 'session_start',
              createdAt: {
                gte: weekStart,
                lt: weekEnd,
              },
            },
          });

          const retentionRate = cohortSize > 0 ? (activeCount.length / cohortSize) * 100 : 0;
          retention.push(Math.round(retentionRate));
        }

        cohorts.push({
          cohortWeek: cohortStart.toISOString().split('T')[0],
          cohortSize,
          retention,
        });
      }

      res.json({ cohorts, timestamp: Date.now() });
    } catch (error) {
      console.error('[Analytics] Retention error:', error);
      res.status(500).json({ error: 'Failed to fetch retention analytics' });
    }
  });

  // Analytics Funnel - conversion funnel metrics
  app.get('/api/analytics/funnel', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const [signups, walletConnected, agentApproved, firstTrades, totalTrades] = await Promise.all([
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: { eventType: 'signup', createdAt: { gte: startDate } },
        }),
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: { eventType: 'wallet_connected', createdAt: { gte: startDate } },
        }),
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: { eventType: 'agent_approved', createdAt: { gte: startDate } },
        }),
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: { eventType: 'first_trade', createdAt: { gte: startDate } },
        }),
        prisma.analyticsEvent.count({
          where: { eventType: 'trade_executed', createdAt: { gte: startDate } },
        }),
      ]);

      const funnel = {
        signups: signups.length,
        walletConnected: walletConnected.length,
        agentApproved: agentApproved.length,
        firstTrade: firstTrades.length,
        totalTrades,
      };

      // Calculate conversion rates
      const rates = {
        signupToWallet: funnel.signups > 0 ? (funnel.walletConnected / funnel.signups) * 100 : 0,
        walletToApproved: funnel.walletConnected > 0 ? (funnel.agentApproved / funnel.walletConnected) * 100 : 0,
        approvedToFirstTrade: funnel.agentApproved > 0 ? (funnel.firstTrade / funnel.agentApproved) * 100 : 0,
        overallConversion: funnel.signups > 0 ? (funnel.firstTrade / funnel.signups) * 100 : 0,
      };

      res.json({ funnel, rates, timestamp: Date.now() });
    } catch (error) {
      console.error('[Analytics] Funnel error:', error);
      res.status(500).json({ error: 'Failed to fetch funnel analytics' });
    }
  });

  // Analytics Engagement - DAU/WAU/MAU
  app.get('/api/analytics/engagement', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      const monthStart = new Date(todayStart);
      monthStart.setDate(monthStart.getDate() - 30);

      const [dauResult, wauResult, mauResult, totalUsers] = await Promise.all([
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: {
            eventType: 'session_start',
            telegramId: { not: null },
            createdAt: { gte: todayStart },
          },
        }),
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: {
            eventType: 'session_start',
            telegramId: { not: null },
            createdAt: { gte: weekStart },
          },
        }),
        prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: {
            eventType: 'session_start',
            telegramId: { not: null },
            createdAt: { gte: monthStart },
          },
        }),
        prisma.user.count(),
      ]);

      const dau = dauResult.length;
      const wau = wauResult.length;
      const mau = mauResult.length;
      const stickiness = mau > 0 ? (dau / mau) * 100 : 0;

      // Get daily active users for past 30 days
      const dailyActiveData: Array<{ date: string; dau: number }> = [];
      for (let i = 29; i >= 0; i--) {
        const dayStart = new Date(todayStart);
        dayStart.setDate(dayStart.getDate() - i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const result = await prisma.analyticsEvent.groupBy({
          by: ['telegramId'],
          where: {
            eventType: 'session_start',
            telegramId: { not: null },
            createdAt: { gte: dayStart, lt: dayEnd },
          },
        });

        dailyActiveData.push({
          date: dayStart.toISOString().split('T')[0],
          dau: result.length,
        });
      }

      res.json({
        dau,
        wau,
        mau,
        totalUsers,
        stickiness: Math.round(stickiness * 100) / 100,
        dailyActiveData,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[Analytics] Engagement error:', error);
      res.status(500).json({ error: 'Failed to fetch engagement analytics' });
    }
  });

  // Analytics Trades - trading activity breakdown
  app.get('/api/analytics/trades', analyticsAuth, async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Get all trade events with metadata
      const trades = await prisma.analyticsEvent.findMany({
        where: {
          eventType: 'trade_executed',
          createdAt: { gte: startDate },
        },
        select: {
          metadata: true,
          createdAt: true,
        },
      });

      // Parse and aggregate trade data
      let totalVolume = 0;
      let longCount = 0;
      let shortCount = 0;
      const leverageDistribution: Record<number, number> = {};
      const dailyVolume: Record<string, number> = {};

      trades.forEach(trade => {
        const meta = trade.metadata ? JSON.parse(trade.metadata) : {};
        const sizeUsd = meta.sizeUsd || 0;
        const leverage = meta.leverage || 1;
        const side = meta.side || 'long';

        totalVolume += sizeUsd;
        if (side === 'long') longCount++;
        else shortCount++;

        leverageDistribution[leverage] = (leverageDistribution[leverage] || 0) + 1;

        const dateStr = trade.createdAt.toISOString().split('T')[0];
        dailyVolume[dateStr] = (dailyVolume[dateStr] || 0) + sizeUsd;
      });

      const dailyVolumeData = Object.entries(dailyVolume)
        .map(([date, volume]) => ({ date, volume }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.json({
        totalTrades: trades.length,
        totalVolume: Math.round(totalVolume * 100) / 100,
        avgTradeSize: trades.length > 0 ? Math.round((totalVolume / trades.length) * 100) / 100 : 0,
        longCount,
        shortCount,
        leverageDistribution,
        dailyVolumeData,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('[Analytics] Trades error:', error);
      res.status(500).json({ error: 'Failed to fetch trades analytics' });
    }
  });

  // Approve builder fee via backend proxy (verifies signer, then submits to Hyperliquid)
  app.post('/api/approve-builder-fee', registrationLimiter, async (req: Request, res: Response) => {
    try {
      const { walletAddress, signature, nonce } = req.body as {
        walletAddress?: string;
        signature?: string;
        nonce?: number;
      };

      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        res.status(400).json({ error: 'Invalid wallet address' });
        return;
      }

      if (!signature || typeof signature !== 'string') {
        res.status(400).json({ error: 'Missing signature' });
        return;
      }

      if (!nonce || typeof nonce !== 'number') {
        res.status(400).json({ error: 'Missing nonce' });
        return;
      }

      if (!BUILDER_ADDRESS) {
        res.status(503).json({ error: 'Builder fee not configured' });
        return;
      }

      console.log('[ApproveBuilderFee] Request:', {
        walletAddress,
        nonce,
        builder: BUILDER_ADDRESS,
      });

      const domain = {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: BUILDER_DOMAIN_CHAIN_ID,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };

      const types = {
        'HyperliquidTransaction:ApproveBuilderFee': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'maxFeeRate', type: 'string' },
          { name: 'builder', type: 'address' },
          { name: 'nonce', type: 'uint64' },
        ],
      };

      const message = {
        hyperliquidChain: 'Mainnet',
        maxFeeRate: BUILDER_MAX_FEE_RATE,
        builder: BUILDER_ADDRESS.toLowerCase(),
        nonce,
      };

      const recovered = ethers.verifyTypedData(domain, types, message, signature);
      console.log('[ApproveBuilderFee] Recovered signer:', recovered);
      if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match wallet address' });
        return;
      }

      const action = {
        type: 'approveBuilderFee',
        hyperliquidChain: 'Mainnet',
        signatureChainId: BUILDER_SIGNATURE_CHAIN_ID,
        maxFeeRate: BUILDER_MAX_FEE_RATE,
        builder: BUILDER_ADDRESS.toLowerCase(),
        nonce,
      };

      const hlResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          nonce,
          signature: ethers.Signature.from(signature),
        }),
      });

      const hlResult = await hlResponse.json();
      console.log('[Hyperliquid] approveBuilderFee response:', JSON.stringify(hlResult));

      res.json({ ok: true, response: hlResult });
    } catch (error) {
      console.error('[ApproveBuilderFee] Error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Client log endpoint for Mini App diagnostics
  app.post('/api/client-log', registrationLimiter, async (req: Request, res: Response) => {
    try {
      const { scope, message, data } = req.body as {
        scope?: string;
        message?: string;
        data?: Record<string, unknown>;
      };

      console.log('[ClientLog]', { scope, message, data });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to log client event' });
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

      // Track signup event
      await trackEvent({
        telegramId: BigInt(telegramUserId),
        eventType: EVENT_TYPES.SIGNUP,
        metadata: { walletAddress: privyUser.walletAddress },
      });

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

  // Builder fee approval completion - called by Mini App after successful approval, auto-executes pending order
  app.post('/api/builder-fee-approved', registrationLimiter, async (req: Request, res: Response) => {
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
      
      console.log(`[BuilderFeeApproved] Executing pending order for user ${telegramUserId}:`, pendingOrder);

      try {
        const hl = await getHyperliquidClient();

        // Verify builder fee is actually approved
        if (BUILDER_ADDRESS) {
          const isApproved = await hl.isBuilderFeeApproved(user.walletAddress, BUILDER_ADDRESS);
          if (!isApproved) {
            console.log('[BuilderFeeApproved] Builder fee still not approved');
            res.json({ success: false, orderExecuted: false, reason: 'builder_fee_not_approved' });
            return;
          }
        }
        
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

  // Start 12-hour chart broadcast scheduler
  startChartScheduler(bot);

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

