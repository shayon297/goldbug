import { Telegraf } from 'telegraf';
import { registerHandlers } from './handlers.js';

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

