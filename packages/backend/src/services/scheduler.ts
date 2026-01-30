import type { Telegraf } from 'telegraf';
import { getAllUsers } from '../state/db.js';
import { getHyperliquidClient, TRADING_ASSET } from '../hyperliquid/client.js';
import { generateChartBuffer, generateChartSummary } from './chart.js';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * Broadcast chart to all users
 */
async function broadcastChart(bot: Telegraf): Promise<void> {
  console.log('[Scheduler] Starting chart broadcast...');
  
  try {
    const hl = await getHyperliquidClient();
    const candles = await hl.getCandles('4h', 100);
    
    if (candles.length === 0) {
      console.log('[Scheduler] No candle data available, skipping broadcast');
      return;
    }

    const chartBuffer = await generateChartBuffer({
      candles,
      symbol: TRADING_ASSET,
      interval: '4H',
    });

    const summary = generateChartSummary(candles, TRADING_ASSET);
    const caption = `${summary}\n\n_Automated update • Reply /chart anytime_`;

    // Get all users
    const users = await getAllUsers();
    console.log(`[Scheduler] Broadcasting to ${users.length} users`);

    let successCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        await bot.telegram.sendPhoto(
          Number(user.telegramId),
          { source: chartBuffer },
          {
            caption,
            parse_mode: 'Markdown',
          }
        );
        successCount++;
        
        // Rate limit: max 30 messages/second for broadcasts
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error: any) {
        errorCount++;
        // User may have blocked the bot or deleted account
        if (error.code === 403 || error.description?.includes('blocked')) {
          console.log(`[Scheduler] User ${user.telegramId} has blocked the bot`);
        } else {
          console.error(`[Scheduler] Failed to send to ${user.telegramId}:`, error.message);
        }
      }
    }

    console.log(`[Scheduler] Broadcast complete: ${successCount} sent, ${errorCount} failed`);
  } catch (error) {
    console.error('[Scheduler] Chart broadcast failed:', error);
  }
}

/**
 * Start the 12-hour chart broadcast scheduler
 */
export function startChartScheduler(bot: Telegraf): void {
  console.log('[Scheduler] Starting 12-hour chart broadcast scheduler');

  // Schedule broadcast every 12 hours
  setInterval(() => {
    broadcastChart(bot);
  }, TWELVE_HOURS_MS);

  // Also broadcast 1 minute after startup (to verify it works)
  setTimeout(() => {
    console.log('[Scheduler] Running initial chart broadcast');
    broadcastChart(bot);
  }, 60 * 1000);
}

/**
 * Manually trigger a chart broadcast (for testing)
 */
export async function triggerChartBroadcast(bot: Telegraf): Promise<void> {
  await broadcastChart(bot);
}

