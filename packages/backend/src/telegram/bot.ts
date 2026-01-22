import { Telegraf } from 'telegraf';
import { registerHandlers } from './handlers.js';
import { TRADING_ASSET } from '../hyperliquid/client.js';

/**
 * Bot command menu items
 */
const BOT_COMMANDS = [
  { command: 'start', description: 'Show main menu & account status' },
  { command: 'long', description: `Open a LONG position on ${TRADING_ASSET}` },
  { command: 'short', description: `Open a SHORT position on ${TRADING_ASSET}` },
  { command: 'position', description: 'View your current position' },
  { command: 'orders', description: 'View open orders' },
  { command: 'fills', description: 'View recent fills' },
  { command: 'balance', description: 'Check account balance' },
  { command: 'bridge', description: '🌉 Bridge USDC to Hyperliquid' },
  { command: 'deposit', description: 'How to fund your wallet' },
  { command: 'close', description: 'Close your position' },
  { command: 'cancel', description: 'Cancel all open orders' },
  { command: 'help', description: 'Show help & commands' },
];

/**
 * Initialize and configure the Telegram bot
 */
export function createBot(): Telegraf {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }

  const bot = new Telegraf(token);

  // Register all handlers
  registerHandlers(bot);

  // Error handler
  bot.catch((err, ctx) => {
    console.error(`[Bot Error] ${ctx.updateType}:`, err);
  });

  return bot;
}

/**
 * Start bot with webhook or polling
 */
export async function startBot(bot: Telegraf, webhookUrl?: string): Promise<void> {
  // Set bot commands (menu)
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    console.log('[Bot] Command menu set');
  } catch (error) {
    console.error('[Bot] Failed to set commands:', error);
  }

  if (webhookUrl) {
    // Production: use webhook
    const secretPath = process.env.TELEGRAM_WEBHOOK_SECRET || 'webhook-secret';
    await bot.telegram.setWebhook(`${webhookUrl}/telegram/${secretPath}`);
    console.log(`[Bot] Webhook set to ${webhookUrl}/telegram/${secretPath}`);
  } else {
    // Development: use polling
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log('[Bot] Started with polling');
  }
}

