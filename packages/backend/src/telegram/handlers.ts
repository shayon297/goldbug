import { Context, Telegraf } from 'telegraf';
import { ethers, Contract } from 'ethers';
import {
  mainMenuKeyboard,
  dashboardKeyboard,
  connectWalletKeyboard,
  sizeSelectionKeyboard,
  leverageSelectionKeyboard,
  orderTypeKeyboard,
  confirmOrderKeyboard,
  postOrderKeyboard,
  balanceKeyboard,
  positionKeyboard,
  settingsKeyboard,
  ordersKeyboard,
  closeConfirmKeyboard,
  authorizeAgentKeyboard,
  approveBuilderFeeKeyboard,
  tradeReceiptKeyboard,
  copiedTradeKeyboard,
} from './keyboards.js';
import { 
  parseTradeCommand, 
  parseCloseCommand, 
  formatTradeCommand, 
  sanitizeInput,
  parseDeepLink,
  generateTradeDeepLink,
  formatTradeReceipt,
} from './parser.js';
import {
  getUserByTelegramId,
  userExists,
  getOrCreateSession,
  updateSession,
  clearSession,
  updateUserPreferences,
  addPoints,
  POINTS_CONFIG,
  type OrderContext,
} from '../state/db.js';
import { trackEvent, EVENT_TYPES, hasUserEvent } from '../state/analytics.js';
import { getHyperliquidClient, TRADING_ASSET } from '../hyperliquid/client.js';
import { generateChartBuffer, generateChartSummary } from '../services/chart.js';

const MINIAPP_URL = process.env.MINIAPP_URL || 'https://goldbug-miniapp.railway.app';
const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'goldbug_tradingbot';
/**
 * Check if user has existing position with different leverage (for warning)
 */
async function getLeverageWarning(walletAddress: string, requestedLeverage: number): Promise<string | null> {
  try {
    const hl = await getHyperliquidClient();
    const position = await hl.getGoldPosition(walletAddress);
    
    if (!position || parseFloat(position.position.szi) === 0) {
      return null; // No existing position
    }
    
    const currentLeverage = position.position.leverage.value;
    const leverageType = position.position.leverage.type;
    
    if (leverageType === 'isolated' && currentLeverage !== requestedLeverage) {
      return `⚠️ *Leverage Warning*\n` +
        `You have an existing ${currentLeverage}x isolated position.\n` +
        `This trade will be added at ${currentLeverage}x (not ${requestedLeverage}x).\n` +
        `_To use ${requestedLeverage}x, close position first._\n\n`;
    }
    
    return null;
  } catch (error) {
    console.error('[LeverageWarning] Error:', error);
    return null; // Don't block order on error
  }
}

// Arbitrum config for balance checking
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

/**
 * Fetch Arbitrum USDC and ETH balances
 */
async function getArbitrumBalances(walletAddress: string): Promise<{ usdc: string; eth: string }> {
  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
    
    const [usdcBal, ethBal] = await Promise.all([
      usdc.balanceOf(walletAddress),
      provider.getBalance(walletAddress),
    ]);
    
    return {
      usdc: ethers.formatUnits(usdcBal, 6),
      eth: ethers.formatUnits(ethBal, 18),
    };
  } catch (error) {
    console.error('[Arbitrum] Failed to fetch balances:', error);
    return { usdc: '0', eth: '0' };
  }
}

/**
 * Format balance and position for display
 */
async function getAccountSummary(walletAddress: string, points?: number): Promise<string> {
  const hl = await getHyperliquidClient();
  
  // Fetch all data in parallel
  const [state, position, price, arbBalances] = await Promise.all([
    hl.getUserState(walletAddress),
    hl.getGoldPosition(walletAddress),
    hl.getGoldPrice(),
    getArbitrumBalances(walletAddress),
  ]);

  const balance = parseFloat(state.marginSummary.accountValue).toFixed(2);
  const withdrawable = parseFloat(state.withdrawable).toFixed(2);
  const arbUsdc = parseFloat(arbBalances.usdc).toFixed(2);
  const arbEth = parseFloat(arbBalances.eth).toFixed(4);

  let positionText = 'No position';
  if (position && parseFloat(position.position.szi) !== 0) {
    const size = parseFloat(position.position.szi);
    const side = size > 0 ? '📈 LONG' : '📉 SHORT';
    const entry = parseFloat(position.position.entryPx).toFixed(2);
    const pnl = parseFloat(position.position.unrealizedPnl).toFixed(2);
    const pnlEmoji = parseFloat(pnl) >= 0 ? '🟢' : '🔴';
    const leverage = position.position.leverage.value;

    positionText = `${side} ${Math.abs(size).toFixed(4)} ${TRADING_ASSET} @ ${leverage}x\nEntry: $${entry}\n${pnlEmoji} PnL: $${pnl}`;
  }

  // Show bridge prompt if funds on Arbitrum but not on Hyperliquid
  const needsBridge = parseFloat(arbBalances.usdc) >= 5 && parseFloat(balance) < 5;
  const bridgeHint = needsBridge ? `\n\n⚠️ *You have USDC on Arbitrum!*\nUse /bridge to move it to Hyperliquid` : '';

  // Points display
  const pointsDisplay = points !== undefined ? `\n\n⭐ *Goldbug Points*: ${points.toLocaleString()}\n_Share trades to earn rewards_` : '';

  return `🏦 *Wallet*\n\`${walletAddress}\`\n\n` +
    `💎 *Hyperliquid*\n💰 Balance: $${balance}\n💵 Withdrawable: $${withdrawable}\n\n` +
    `🔷 *Arbitrum*\n💵 USDC: $${arbUsdc}\n⛽ ETH: ${arbEth}${bridgeHint}\n\n` +
    `📊 *${TRADING_ASSET} Position*\n${positionText}\n\n` +
    `💲 *${TRADING_ASSET} Price*: $${price.toFixed(2)}${pointsDisplay}`;
}

/**
 * Format wallet address for display (truncated)
 */
function formatWalletAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}


/**
 * Register all bot command and callback handlers
 */
export function registerHandlers(bot: Telegraf) {
  // /start command - handles deep links for shared trades
  bot.command('start', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const exists = await userExists(telegramId);

    // Track session start event
    if (exists) {
      await trackEvent({
        telegramId,
        eventType: EVENT_TYPES.SESSION_START,
        metadata: { command: 'start' },
      });
    }

    // Extract deep link payload (text after "/start ")
    const messageText = ctx.message.text || '';
    const payload = messageText.replace(/^\/start\s*/, '').trim();
    
    // Parse deep link if present
    const deepLink = parseDeepLink(payload);

    if (!exists) {
      // New user - show welcome with connect wallet
      // TODO: Store referral attribution if present in deep link
      await ctx.replyWithMarkdown(
        `🥇 *Trade ${TRADING_ASSET} on Hyperliquid*\n\n` +
          `Up to 20x leverage • Market & Limit orders • Gasless trading\n\n` +
          `⏱️ Setup takes ~30 seconds`,
        connectWalletKeyboard(MINIAPP_URL)
      );
      return;
    }
    
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    // Handle trade deep link - show prefilled trade confirmation
    if (deepLink.type === 'trade' && deepLink.trade) {
      const { side, sizeUsd, leverage, orderType } = deepLink.trade;
      
      // Store in session for confirmation
      const session: OrderContext = {
        side,
        sizeUsd,
        leverage,
        orderType,
        step: 'confirm',
      };
      await updateSession(telegramId, session);

      try {
        const hl = await getHyperliquidClient();
        const [price, state] = await Promise.all([
          hl.getGoldPrice(),
          hl.getUserState(user.walletAddress),
        ]);
        const balance = parseFloat(state.marginSummary.accountValue);
        
        const sideEmoji = side === 'long' ? '📈' : '📉';
        const summary = formatTradeCommand({ side, sizeUsd, leverage, orderType }, price, balance);
        
        await ctx.replyWithMarkdown(
          `📋 *Shared Trade*\n\n${summary}\n\n` +
          `_Tap Execute to copy this trade_`,
          copiedTradeKeyboard()
        );
      } catch (error) {
        await ctx.reply('Error loading trade. Please try again.', mainMenuKeyboard());
      }
      return;
    }

    // Handle expired or invalid deep link
    if (deepLink.error) {
      await ctx.reply(`⚠️ ${deepLink.error}`, mainMenuKeyboard());
      // Fall through to show dashboard
    }

    // Normal /start - show dashboard
    try {
      const hl = await getHyperliquidClient();
      
      // Fetch all data in parallel
      const [state, position, price] = await Promise.all([
        hl.getUserState(user.walletAddress),
        hl.getGoldPosition(user.walletAddress),
        hl.getGoldPrice(),
      ]);

      const balance = parseFloat(state.marginSummary.accountValue).toFixed(2);
      const hasPosition = !!(position && parseFloat(position.position.szi) !== 0);

      // Build compact dashboard
      let positionText = 'No position';
      if (hasPosition) {
        const size = parseFloat(position.position.szi);
        const side = size > 0 ? 'LONG' : 'SHORT';
        const entry = parseFloat(position.position.entryPx).toFixed(2);
        const pnl = parseFloat(position.position.unrealizedPnl);
        const pnlSign = pnl >= 0 ? '+' : '';
        const leverage = position.position.leverage.value;
        positionText = `${side} ${Math.abs(size).toFixed(4)} @ $${entry} (${pnlSign}$${pnl.toFixed(2)})`;
      }

      // Count open orders
      const orders = await hl.getOpenOrders(user.walletAddress);
      const ordersText = orders.length > 0 ? `${orders.length} open` : 'none';

      const dashboard = 
        `🥇 *${TRADING_ASSET} Trading Bot*\n\n` +
        `💰 *Balance:* $${balance}\n` +
        `📊 *Position:* ${positionText}\n` +
        `📋 *Orders:* ${ordersText}\n` +
        `💲 *Price:* $${price.toFixed(2)}`;

      await ctx.replyWithMarkdown(dashboard, dashboardKeyboard(hasPosition, MINIAPP_URL));
    } catch (error) {
      await ctx.replyWithMarkdown(
        `🥇 *${TRADING_ASSET} Trading Bot*\n\n` +
        `✅ *Wallet Connected*\n` +
        `\`${formatWalletAddress(user.walletAddress)}\`\n\n` +
        `⚠️ Could not fetch account data. Try /balance`,
        mainMenuKeyboard()
      );
    }
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.replyWithMarkdown(
      `🥇 *${TRADING_ASSET} Trade Bot*\n\n` +
      `*Trading:*\n` +
      `/long - Open a long position\n` +
      `/short - Open a short position\n` +
      `/close - Close your position\n` +
      `/status - Balance, position & orders\n` +
      `/price - Current price\n\n` +
      `*Funding:*\n` +
      `/fund - Add or withdraw funds\n` +
      `/onramp - Buy USDC with card/bank\n` +
      `/withdraw - Sell USDC to bank\n` +
      `/bridge - Bridge USDC to Hyperliquid\n\n` +
      `*Quick Trade Examples:*\n` +
      `• \`/long $100 5x\`\n` +
      `• \`/short $500 10x market\`\n` +
      `• \`Long 5x $250 limit 2800\`\n\n` +
      `💡 Just type naturally - no need for exact syntax!`
    );
  });

  // /status command (combines position + balance + orders)
  bot.command('status', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const summary = await getAccountSummary(user.walletAddress, user.points);
      await ctx.replyWithMarkdown(summary, balanceKeyboard(MINIAPP_URL));
    } catch (error) {
      await ctx.reply('Error fetching status. Please try again.');
    }
  });

  // /fund command (combines all funding options)
  bot.command('fund', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `💰 *Manage Funds*\n\n` +
      `*Your Wallet:*\n\`${user.walletAddress}\`\n\n` +
      `Choose an option:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Buy USDC', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
            [{ text: '🌉 Bridge to Hyperliquid', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
            [{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
            [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
          ],
        },
      }
    );
  });

  // /price command
  bot.command('price', async (ctx) => {
    try {
      const hl = await getHyperliquidClient();
      const price = await hl.getGoldPrice();
      await ctx.replyWithMarkdown(
        `💲 *${TRADING_ASSET}*: $${price.toFixed(2)}`,
        mainMenuKeyboard()
      );
    } catch (error) {
      await ctx.reply('Error fetching price. Please try again.');
    }
  });

  // /chart command - generate price chart with indicators
  bot.command('chart', async (ctx) => {
    try {
      await ctx.reply('📊 Generating chart...');
      
      const hl = await getHyperliquidClient();
      const candles = await hl.getCandles('4h', 100);
      
      if (candles.length === 0) {
        await ctx.reply('No chart data available. Please try again later.');
        return;
      }

      const chartBuffer = await generateChartBuffer({
        candles,
        symbol: TRADING_ASSET,
        interval: '4H',
      });

      const summary = generateChartSummary(candles, TRADING_ASSET);

      await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: summary,
          parse_mode: 'Markdown',
        }
      );
    } catch (error) {
      console.error('[Chart] Error generating chart:', error);
      await ctx.reply('Error generating chart. Please try again later.');
    }
  });

  // /debug command - show agent status
  bot.command('debug', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.replyWithMarkdown('❌ Not connected. Use /start first.');
      return;
    }

    await ctx.replyWithMarkdown(
      `🔧 *Debug Info*\n\n` +
      `*Wallet:* \`${user.walletAddress}\`\n` +
      `*Agent:* \`${user.agentAddress}\`\n\n` +
      `Compare this agent address with what's approved on Hyperliquid.`
    );
  });

  // /deposit command - funding instructions
  bot.command('deposit', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    let walletInfo = '';
    if (user) {
      walletInfo = `\n\n💳 *Your Wallet:*\n\`${user.walletAddress}\`\n`;
    }

    await ctx.replyWithMarkdown(
      `💰 *How to Fund Your Wallet*${walletInfo}\n` +
      `*Step 1: Get USDC on Arbitrum*\n` +
      `• Buy USDC on an exchange (Coinbase, Binance, etc.)\n` +
      `• Withdraw to your wallet on *Arbitrum One*\n` +
      `• Or bridge from another chain to Arbitrum\n\n` +
      `*Step 2: Deposit to Hyperliquid*\n` +
      `• Go to [app.hyperliquid.xyz](https://app.hyperliquid.xyz)\n` +
      `• Connect the same wallet you linked here\n` +
      `• Click *Deposit* and select USDC amount\n` +
      `• Confirm the transaction (~$0.01 gas)\n\n` +
      `*Step 3: Start Trading!*\n` +
      `• Your USDC balance appears automatically\n` +
      `• Use /long or /short to open positions\n` +
      `• Trading on Hyperliquid is *gasless* ⚡\n\n` +
      `💡 *Minimum:* $10 USDC to start trading\n` +
      `➕ *Adding more later:* just send more USDC to the same wallet address above`
    );
  });


  // /bridge command - one-click bridge to Hyperliquid
  bot.command('bridge', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `🌉 *Bridge USDC to Hyperliquid*\n\n` +
      `Your wallet:\n\`${user.walletAddress}\`\n\n` +
      `Tap the button below to bridge your USDC from Arbitrum to Hyperliquid instantly.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌉 Bridge Now', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
          ],
        },
      }
    );
  });

  // /onramp command - open Mini App on onramp selector
  bot.command('onramp', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `💳 *Buy USDC*\n\n` +
      `Purchase USDC with card, bank transfer, or other payment methods.\n` +
      `KYC may be required depending on your region.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Buy USDC', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
          ],
        },
      }
    );
  });

  // /offramp command - sell crypto for fiat
  bot.command('offramp', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `🏦 *Sell USDC*\n\n` +
      `Convert your USDC to fiat and withdraw to your bank.\n\n` +
      `⚠️ *Note:* Your USDC must be on Arbitrum (not Hyperliquid).\n` +
      `Use the Hyperliquid website to withdraw first if needed.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏦 Sell USDC', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
          ],
        },
      }
    );
  });

  // /withdraw command - alias for offramp (more intuitive name)
  bot.command('withdraw', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `🏦 *Withdraw to Bank*\n\n` +
      `Convert your USDC to fiat and withdraw to your bank account.\n\n` +
      `⚠️ *Important:* Your USDC must be on Arbitrum.\n` +
      `If your funds are on Hyperliquid, withdraw to Arbitrum first at [app.hyperliquid.xyz](https://app.hyperliquid.xyz).`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
          ],
        },
      }
    );
  });

  // /position command
  bot.command('position', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const position = await hl.getGoldPosition(user.walletAddress);

      if (!position || parseFloat(position.position.szi) === 0) {
        await ctx.replyWithMarkdown(`📊 *No ${TRADING_ASSET} Position*\n\nOpen a position to get started.`, mainMenuKeyboard());
        return;
      }

      const size = parseFloat(position.position.szi);
      const side = size > 0 ? '📈 LONG' : '📉 SHORT';
      const entry = parseFloat(position.position.entryPx).toFixed(2);
      const pnl = parseFloat(position.position.unrealizedPnl).toFixed(2);
      const pnlEmoji = parseFloat(pnl) >= 0 ? '🟢' : '🔴';
      const leverage = position.position.leverage.value;
      const liqPx = position.position.liquidationPx
        ? `$${parseFloat(position.position.liquidationPx).toFixed(2)}`
        : 'N/A';

      await ctx.replyWithMarkdown(
        `📊 *${TRADING_ASSET} Position*\n\n` +
          `${side} ${Math.abs(size).toFixed(4)} ${TRADING_ASSET}\n` +
          `📊 Leverage: ${leverage}x\n` +
          `💵 Entry: $${entry}\n` +
          `${pnlEmoji} PnL: $${pnl}\n` +
          `⚠️ Liquidation: ${liqPx}`,
        positionKeyboard(true)
      );
    } catch (error) {
      await ctx.reply('Error fetching position. Please try again.');
    }
  });

  // /close command
  bot.command('close', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const position = await hl.getGoldPosition(user.walletAddress);

      if (!position || parseFloat(position.position.szi) === 0) {
        await ctx.reply('No position to close.', mainMenuKeyboard());
        return;
      }

      const size = parseFloat(position.position.szi);
      const side = size > 0 ? 'LONG' : 'SHORT';
      const pnl = parseFloat(position.position.unrealizedPnl).toFixed(2);

      await ctx.replyWithMarkdown(
        `🔴 *Close Position?*\n\n` +
          `${side} ${Math.abs(size).toFixed(4)} ${TRADING_ASSET}\n` +
          `Current PnL: $${pnl}`,
        closeConfirmKeyboard()
      );
    } catch (error) {
      await ctx.reply('Error fetching position. Please try again.');
    }
  });

  // /cancel command (cancel all orders)
  bot.command('cancel', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const orders = await hl.getOpenOrders(user.walletAddress);

      if (orders.length === 0) {
        await ctx.reply('No open orders to cancel.', mainMenuKeyboard());
        return;
      }

      await hl.cancelAllOrders(user.agentPrivateKey, user.walletAddress);
      await ctx.reply(`✅ Cancelled ${orders.length} order(s).`, mainMenuKeyboard());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`❌ Error: ${message}`, mainMenuKeyboard());
    }
  });

  // /orders command
  bot.command('orders', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const orders = await hl.getOpenOrders(user.walletAddress);

      if (orders.length === 0) {
        await ctx.replyWithMarkdown('📋 *No Open Orders*', mainMenuKeyboard());
        return;
      }

      const orderList = orders
        .map((o) => {
          const side = o.side === 'B' ? '📈 BUY' : '📉 SELL';
          return `${side} ${o.sz} @ $${o.limitPx} (#${o.oid})`;
        })
        .join('\n');

      await ctx.replyWithMarkdown(`📋 *Open ${TRADING_ASSET} Orders*\n\n${orderList}`, ordersKeyboard(orders.map((o) => o.oid)));
    } catch (error) {
      await ctx.reply('Error fetching orders. Please try again.');
    }
  });

  // /fills command
  bot.command('fills', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const fills = await hl.getUserFills(user.walletAddress);
      const recent = fills.slice(0, 5);

      if (recent.length === 0) {
        await ctx.reply(`No recent ${TRADING_ASSET} fills.`);
        return;
      }

      const lines = recent.map((fill) => {
        const time = new Date(fill.time).toLocaleString();
        return `• ${fill.side} ${fill.sz} @ $${fill.px} (oid ${fill.oid})\n  ${time}`;
      });

      await ctx.replyWithMarkdown(`*Recent Fills (${TRADING_ASSET})*\n\n${lines.join('\n')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`❌ Error: ${message}`);
    }
  });

  // /balance command
  bot.command('balance', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const summary = await getAccountSummary(user.walletAddress, user.points);
      await ctx.replyWithMarkdown(summary, balanceKeyboard(MINIAPP_URL));
    } catch (error) {
      await ctx.reply('Error fetching balance. Please try again.');
    }
  });

  // /long and /short shortcuts
  bot.command('long', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);
    
    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    const text = ctx.message.text || '';
    const args = text.replace(/^\/long/i, '').trim();
    if (args.length > 0) {
      const parsed = parseTradeCommand(`long ${args}`);
      if (parsed.success && parsed.command) {
        const hasType = args.includes('market') || args.includes('limit');
        const session: OrderContext = {
          side: 'long',
          sizeUsd: parsed.command.sizeUsd,
          leverage: parsed.command.leverage,
          orderType: hasType ? parsed.command.orderType : undefined,
          limitPrice: parsed.command.limitPrice,
          step: hasType ? 'confirm' : 'select_type',
        };
        await updateSession(telegramId, session);

        if (!hasType) {
          await ctx.reply(
            `Long ${TRADING_ASSET}\nSize: $${parsed.command.sizeUsd}\nLeverage: ${parsed.command.leverage}x\n\nSelect order type:`,
            orderTypeKeyboard()
          );
          return;
        }

        const hl = await getHyperliquidClient();
        const [leverageWarning, price, state] = await Promise.all([
          getLeverageWarning(user.walletAddress, parsed.command.leverage),
          hl.getGoldPrice(),
          hl.getUserState(user.walletAddress),
        ]);
        const balance = parseFloat(state.marginSummary.accountValue);
        const summary = formatTradeCommand(parsed.command, price, balance);
        await ctx.replyWithMarkdown(`*Confirm Order*\n\n${leverageWarning || ''}${summary}`, confirmOrderKeyboard());
        return;
      }

      await ctx.reply(`❌ ${parsed.error || 'Invalid command. Try /long $10 2x'}`);
      return;
    }

    await handleSideSelection(ctx, 'long');
  });

  bot.command('short', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);
    
    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    const text = ctx.message.text || '';
    const args = text.replace(/^\/short/i, '').trim();
    if (args.length > 0) {
      const parsed = parseTradeCommand(`short ${args}`);
      if (parsed.success && parsed.command) {
        const hasType = args.includes('market') || args.includes('limit');
        const session: OrderContext = {
          side: 'short',
          sizeUsd: parsed.command.sizeUsd,
          leverage: parsed.command.leverage,
          orderType: hasType ? parsed.command.orderType : undefined,
          limitPrice: parsed.command.limitPrice,
          step: hasType ? 'confirm' : 'select_type',
        };
        await updateSession(telegramId, session);

        if (!hasType) {
          await ctx.reply(
            `Short ${TRADING_ASSET}\nSize: $${parsed.command.sizeUsd}\nLeverage: ${parsed.command.leverage}x\n\nSelect order type:`,
            orderTypeKeyboard()
          );
          return;
        }

        const hl = await getHyperliquidClient();
        const [leverageWarning, price, state] = await Promise.all([
          getLeverageWarning(user.walletAddress, parsed.command.leverage),
          hl.getGoldPrice(),
          hl.getUserState(user.walletAddress),
        ]);
        const balance = parseFloat(state.marginSummary.accountValue);
        const summary = formatTradeCommand(parsed.command, price, balance);
        await ctx.replyWithMarkdown(`*Confirm Order*\n\n${leverageWarning || ''}${summary}`, confirmOrderKeyboard());
        return;
      }

      await ctx.reply(`❌ ${parsed.error || 'Invalid command. Try /short $10 2x'}`);
      return;
    }

    await handleSideSelection(ctx, 'short');
  });

  // Handle text messages (natural language commands)
  bot.on('text', async (ctx) => {
    // Skip if this is a command (starts with /)
    if (ctx.message.text.startsWith('/')) {
      return;
    }

    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      return; // Ignore if not connected
    }

    const session = await getOrCreateSession(telegramId);

    // Check if waiting for custom input
    if (session.step === 'select_size') {
      const input = sanitizeInput(ctx.message.text);
      const value = parseFloat(input.replace('$', ''));

      if (isNaN(value)) {
        await ctx.reply('Please enter a valid number (e.g., "$50" or "50")');
        return;
      }

      if (value < 10) {
        await ctx.reply('Minimum size is $10');
        return;
      }

      if (value > 100000) {
        await ctx.reply('Maximum size is $100,000');
        return;
      }

      session.sizeUsd = value;
      session.step = 'select_leverage';
      await updateSession(telegramId, session);
      await ctx.reply(`Size set to $${value}. Select leverage:`, leverageSelectionKeyboard());
      return;
    }

    const sanitized = sanitizeInput(ctx.message.text);

    // Check for close command first (e.g., "close", "close half", "close 50%")
    const closeResult = parseCloseCommand(sanitized);
    if (closeResult.isClose) {
      await handleCloseText(ctx, user, closeResult.fraction);
      return;
    }

    // Try to parse as natural language trade command
    const parsed = parseTradeCommand(sanitized);

    if (parsed.success && parsed.command) {
      // Store in session and go to confirm
      const newSession: OrderContext = {
        side: parsed.command.side,
        sizeUsd: parsed.command.sizeUsd,
        leverage: parsed.command.leverage,
        orderType: parsed.command.orderType,
        limitPrice: parsed.command.limitPrice,
        step: 'confirm',
      };
      await updateSession(telegramId, newSession);

      const hl = await getHyperliquidClient();
      const [leverageWarning, price, state] = await Promise.all([
        getLeverageWarning(user.walletAddress, parsed.command.leverage),
        hl.getGoldPrice(),
        hl.getUserState(user.walletAddress),
      ]);
      const balance = parseFloat(state.marginSummary.accountValue);
      const summary = formatTradeCommand(parsed.command, price, balance);
      await ctx.replyWithMarkdown(`*Confirm Order*\n\n${leverageWarning || ''}${summary}`, confirmOrderKeyboard());
    } else if (parsed.error) {
      await ctx.reply(`❌ ${parsed.error}`);
    }
  });

  // Callback query handlers
  bot.action(/^action:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();

    switch (action) {
      case 'long':
        await handleSideSelection(ctx, 'long');
        break;
      case 'short':
        await handleSideSelection(ctx, 'short');
        break;
      case 'position':
        await handleViewPosition(ctx);
        break;
      case 'orders':
        await handleViewOrders(ctx);
        break;
      case 'close':
        await handleClosePosition(ctx);
        break;
      case 'cancel_all':
        await handleCancelAllOrders(ctx);
        break;
      case 'settings':
        await handleSettings(ctx);
        break;
      case 'details':
        await handleDetails(ctx);
        break;
      case 'menu':
      case 'refresh':
        await handleRefresh(ctx);
        break;
      case 'cancel':
        await handleCancel(ctx);
        break;
    }
  });

  // Size selection
  bot.action(/^size:(.+)$/, async (ctx) => {
    const sizeValue = ctx.match[1];
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const session = await getOrCreateSession(telegramId);

    if (sizeValue === 'custom') {
      await ctx.editMessageText('Enter custom size (min $10, e.g., "$750" or "750"):');
      return;
    }

    session.sizeUsd = parseInt(sizeValue, 10);
    session.step = 'select_leverage';
    await updateSession(telegramId, session);

    await ctx.editMessageText(`Size: $${sizeValue}\n\nSelect leverage:`, leverageSelectionKeyboard());
  });

  // Leverage selection
  bot.action(/^leverage:(\d+)$/, async (ctx) => {
    const leverage = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const session = await getOrCreateSession(telegramId);

    session.leverage = leverage;
    session.step = 'select_type';
    await updateSession(telegramId, session);

    // Enforce minimum margin requirement: size / leverage must be >= $10
    if ((session.sizeUsd || 0) / leverage < 10) {
      const minSize = Math.ceil(leverage * 10);
      session.step = 'select_size';
      await updateSession(telegramId, session);
      await ctx.editMessageText(
        `❌ Minimum margin is $10.\nWith ${leverage}x leverage, minimum size is $${minSize}.\n\nSelect a larger size:`,
        sizeSelectionKeyboard()
      );
      return;
    }

    await ctx.editMessageText(
      `${session.side?.toUpperCase()} ${TRADING_ASSET}\nSize: $${session.sizeUsd}\nLeverage: ${leverage}x\n\nSelect order type:`,
      orderTypeKeyboard()
    );
  });

  // Order type selection
  bot.action(/^type:(market|limit)$/, async (ctx) => {
    const orderType = ctx.match[1] as 'market' | 'limit';
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);
    const session = await getOrCreateSession(telegramId);

    session.orderType = orderType;
    session.step = 'confirm';
    await updateSession(telegramId, session);

    if (orderType === 'limit') {
      await ctx.editMessageText('Enter limit price (e.g., "2800"):');
      return;
    }

    const hl = await getHyperliquidClient();
    const [leverageWarning, price, state] = await Promise.all([
      user ? getLeverageWarning(user.walletAddress, session.leverage!) : Promise.resolve(null),
      hl.getGoldPrice(),
      user ? hl.getUserState(user.walletAddress) : Promise.resolve({ marginSummary: { accountValue: '0' } }),
    ]);
    const balance = parseFloat(state.marginSummary.accountValue);
    const summary = formatTradeCommand({
      side: session.side!,
      sizeUsd: session.sizeUsd!,
      leverage: session.leverage!,
      orderType: session.orderType!,
      limitPrice: session.limitPrice,
    }, price, balance);

    await ctx.editMessageText(`*Confirm Order*\n\n${leverageWarning || ''}${summary}`, {
      parse_mode: 'Markdown',
      ...confirmOrderKeyboard(),
    });
  });

  // Order confirmation
  bot.action(/^confirm:(yes|no)$/, async (ctx) => {
    const confirmed = ctx.match[1] === 'yes';
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);

    if (!confirmed) {
      await clearSession(telegramId);
      await ctx.editMessageText('Order cancelled.', mainMenuKeyboard());
      return;
    }

    const session = await getOrCreateSession(telegramId);
    const user = await getUserByTelegramId(telegramId);

    if (!user || !session.side || !session.sizeUsd || !session.leverage || !session.orderType) {
      await ctx.editMessageText('Session expired. Please try again.', mainMenuKeyboard());
      return;
    }

    await ctx.editMessageText('⏳ Checking order...');

    try {
      const hl = await getHyperliquidClient();

      // Check builder fee approval before placing order
      if (BUILDER_ADDRESS) {
        const isApproved = await hl.isBuilderFeeApproved(user.walletAddress, BUILDER_ADDRESS);
        if (!isApproved) {
          // Save pending order for auto-execution after approval
          await updateSession(telegramId, {
            ...session,
            step: 'idle',
            pendingOrder: {
              side: session.side!,
              sizeUsd: session.sizeUsd!,
              leverage: session.leverage!,
              orderType: session.orderType!,
              limitPrice: session.limitPrice,
            },
          });

          await ctx.editMessageText(
            `🔒 *One-Time Setup*\n\n` +
              `Approve trading fees to start (0.1% per trade).\n` +
              `Your order will execute automatically after.\n\n` +
              `_This only needs to be done once._`,
            { parse_mode: 'Markdown', ...approveBuilderFeeKeyboard(MINIAPP_URL) }
          );
          return;
        }
      }

      await ctx.editMessageText('⏳ Executing order...');

      const result = await hl.placeOrder(user.agentPrivateKey, user.walletAddress, {
        side: session.side,
        sizeUsd: session.sizeUsd,
        leverage: session.leverage,
        orderType: session.orderType,
        limitPrice: session.limitPrice,
      });

      await clearSession(telegramId);

      if (result.status === 'ok') {
        const response = result.response?.data?.statuses[0];
        if (response?.filled) {
          const sideEmoji = session.side === 'long' ? '📈' : '📉';
          const avgPrice = parseFloat(response.filled.avgPx);
          const totalSz = parseFloat(response.filled.totalSz);
          const notionalUsd = (avgPrice * totalSz).toFixed(2);
          
          // Track trade event
          const isFirstTrade = !(await hasUserEvent(telegramId, EVENT_TYPES.TRADE_EXECUTED));
          if (isFirstTrade) {
            await trackEvent({
              telegramId,
              eventType: EVENT_TYPES.FIRST_TRADE,
              metadata: { side: session.side, sizeUsd: session.sizeUsd, leverage: session.leverage },
            });
          }
          await trackEvent({
            telegramId,
            eventType: EVENT_TYPES.TRADE_EXECUTED,
            metadata: {
              side: session.side,
              sizeUsd: session.sizeUsd,
              leverage: session.leverage,
              orderType: session.orderType,
              avgPrice,
              totalSz,
            },
          });
          
          // Use trade receipt keyboard with share/copy buttons
          const receiptKeyboard = tradeReceiptKeyboard({
            side: session.side,
            sizeUsd: session.sizeUsd,
            leverage: session.leverage,
            entryPrice: avgPrice,
          });
          
          await ctx.editMessageText(
            `✅ *Order Filled*\n\n` +
              `${sideEmoji} *${session.side.toUpperCase()}* ${totalSz.toFixed(4)} ${TRADING_ASSET}\n` +
              `💵 Entry: $${avgPrice.toLocaleString()}\n` +
              `📊 Leverage: ${session.leverage}x\n` +
              `💰 Notional: $${notionalUsd}`,
            { parse_mode: 'Markdown', ...receiptKeyboard }
          );
        } else if (response?.resting) {
          const sideEmoji = session.side === 'long' ? '📈' : '📉';
          await ctx.editMessageText(
            `📝 *Limit Order Placed*\n\n` +
              `${sideEmoji} *${session.side.toUpperCase()}* $${session.sizeUsd} @ ${session.leverage}x\n` +
              `⏳ Waiting at limit price\n` +
              `🔖 Order ID: #${response.resting.oid}`,
            { parse_mode: 'Markdown', ...postOrderKeyboard() }
          );
        } else if (response?.error) {
          await ctx.editMessageText(`❌ Order rejected: ${response.error}`, mainMenuKeyboard());
        } else {
          const statusSummary = formatOrderStatus(result.response);
          await ctx.editMessageText(
            `⚠️ *Order submitted but not filled*\n${statusSummary}`,
            { parse_mode: 'Markdown', ...postOrderKeyboard() }
          );
        }
      } else {
        const errorMsg = result.error || 'Unknown error';
        
        // Check if agent not approved on Hyperliquid (user deposited but hasn't authorized yet)
        if (errorMsg.includes('does not exist') || errorMsg.includes('User or API Wallet')) {
          // Save pending order for auto-retry after authorization
          await updateSession(telegramId, {
            ...session,
            step: 'idle',
            pendingOrder: {
              side: session.side!,
              sizeUsd: session.sizeUsd!,
              leverage: session.leverage!,
              orderType: session.orderType!,
              limitPrice: session.limitPrice,
            },
          });
          
          await ctx.editMessageText(
            `🔐 *Authorization Required*\n\n` +
            `Your wallet has funds but trading isn't enabled yet.\n` +
            `Tap below to authorize trading.\n\n` +
            `_Your order will execute automatically after authorization._`,
            { parse_mode: 'Markdown', ...authorizeAgentKeyboard(MINIAPP_URL) }
          );
        } else if (errorMsg.toLowerCase().includes('builder fee')) {
          // Builder fee not approved - save order and show approval button
          await updateSession(telegramId, {
            ...session,
            step: 'idle',
            pendingOrder: {
              side: session.side!,
              sizeUsd: session.sizeUsd!,
              leverage: session.leverage!,
              orderType: session.orderType!,
              limitPrice: session.limitPrice,
            },
          });
          await ctx.editMessageText(
            `🔒 *One-Time Setup*\n\n` +
            `Approve trading fees to start (0.1% per trade).\n` +
            `Your order will execute automatically after.\n\n` +
            `_This only needs to be done once._`,
            { parse_mode: 'Markdown', ...approveBuilderFeeKeyboard(MINIAPP_URL) }
          );
        } else {
          await ctx.editMessageText(`❌ Order failed: ${errorMsg}`, mainMenuKeyboard());
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if agent not approved on Hyperliquid
      if (message.includes('does not exist') || message.includes('User or API Wallet')) {
        // Save pending order for auto-retry after authorization
        await updateSession(telegramId, {
          ...session,
          step: 'idle',
          pendingOrder: {
            side: session.side!,
            sizeUsd: session.sizeUsd!,
            leverage: session.leverage!,
            orderType: session.orderType!,
            limitPrice: session.limitPrice,
          },
        });
        
        await ctx.editMessageText(
          `🔐 *Authorization Required*\n\n` +
          `Your wallet has funds but trading isn't enabled yet.\n` +
          `Tap below to authorize trading.\n\n` +
          `_Your order will execute automatically after authorization._`,
          { parse_mode: 'Markdown', ...authorizeAgentKeyboard(MINIAPP_URL) }
        );
      } else if (message.toLowerCase().includes('builder fee')) {
        // Builder fee not approved - save order and show approval button
        await updateSession(telegramId, {
          ...session,
          step: 'idle',
          pendingOrder: {
            side: session.side!,
            sizeUsd: session.sizeUsd!,
            leverage: session.leverage!,
            orderType: session.orderType!,
            limitPrice: session.limitPrice,
          },
        });
        await ctx.editMessageText(
          `🔒 *One-Time Setup*\n\n` +
          `Approve trading fees to start (0.1% per trade).\n` +
          `Your order will execute automatically after.\n\n` +
          `_This only needs to be done once._`,
          { parse_mode: 'Markdown', ...approveBuilderFeeKeyboard(MINIAPP_URL) }
        );
      } else {
        await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
      }
    }
  });

  // Close position confirmation
  bot.action('close:confirm', async (ctx) => {
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.editMessageText('Please connect your wallet first.');
      return;
    }

    await ctx.editMessageText('⏳ Closing position...');

    try {
      const hl = await getHyperliquidClient();

      const result = await hl.closePosition(user.agentPrivateKey, user.walletAddress);

      if (result.status === 'ok') {
        const response = result.response?.data?.statuses[0];
        if (response?.filled) {
          await ctx.editMessageText(
            `✅ *Position Closed*\n\n` +
              `Size: ${response.filled.totalSz} ${TRADING_ASSET}\n` +
              `Close Price: $${response.filled.avgPx}`,
            { parse_mode: 'Markdown', ...mainMenuKeyboard() }
          );
        } else {
          await ctx.editMessageText('Position closed.', mainMenuKeyboard());
        }
      } else {
        const errorMsg = result.error || 'Unknown error';
        
        // Check if agent not approved on Hyperliquid
        if (errorMsg.includes('does not exist') || errorMsg.includes('User or API Wallet')) {
          await ctx.editMessageText(
            `🔐 *Authorization Required*\n\n` +
            `Your wallet has funds but trading isn't enabled yet.\n` +
            `Tap below to authorize trading:`,
            { parse_mode: 'Markdown', ...authorizeAgentKeyboard(MINIAPP_URL) }
          );
        } else {
          await ctx.editMessageText(`❌ Failed to close: ${errorMsg}`, mainMenuKeyboard());
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if agent not approved on Hyperliquid
      if (message.includes('does not exist') || message.includes('User or API Wallet')) {
        await ctx.editMessageText(
          `🔐 *Authorization Required*\n\n` +
          `Your wallet has funds but trading isn't enabled yet.\n` +
          `Tap below to authorize trading:`,
          { parse_mode: 'Markdown', ...authorizeAgentKeyboard(MINIAPP_URL) }
        );
      } else {
        await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
      }
    }
  });

  // Cancel specific order
  bot.action(/^cancel_order:(\d+)$/, async (ctx) => {
    const orderId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) return;

    try {
      const hl = await getHyperliquidClient();

      const result = await hl.cancelOrder(user.agentPrivateKey, user.walletAddress, orderId);

      if (result.status === 'ok') {
        await ctx.editMessageText(`✅ Order #${orderId} cancelled.`, mainMenuKeyboard());
      } else {
        await ctx.editMessageText(`❌ Failed to cancel: ${result.error}`, mainMenuKeyboard());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
    }
  });

  // Share trade - generate deep link for others to copy
  // Format: share:{side}_{sizeUsd}_{leverage}_{entryPrice}
  bot.action(/^share:([LS])_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Generating share link...');

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    const [sideCode, sizeStr, leverageStr, priceStr] = [
      ctx.match[1],
      ctx.match[2],
      ctx.match[3],
      ctx.match[4],
    ];

    const side = sideCode === 'L' ? 'long' : 'short';
    const sizeUsd = parseInt(sizeStr, 10);
    const leverage = parseInt(leverageStr, 10);
    const entryPrice = parseInt(priceStr, 10);

    // Award points for sharing
    const newPoints = await addPoints(telegramId, POINTS_CONFIG.SHARE_TRADE);

    // Generate shareable receipt
    const receipt = formatTradeReceipt(side, sizeUsd, leverage, entryPrice, BOT_USERNAME);

    await ctx.reply(
      `📤 *Share this trade:*\n\n${receipt}\n\n` +
      `⭐ *+${POINTS_CONFIG.SHARE_TRADE} points!* (Total: ${newPoints.toLocaleString()})\n` +
      `_Forward this message to any group or chat!_`,
      { parse_mode: 'Markdown' }
    );
  });

  // Copy trade setup - prefill trade from shared params
  // Format: copy:{side}_{sizeUsd}_{leverage}
  bot.action(/^copy:([LS])_(\d+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.editMessageText('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    const [sideCode, sizeStr, leverageStr] = [
      ctx.match[1],
      ctx.match[2],
      ctx.match[3],
    ];

    const side = sideCode === 'L' ? 'long' : 'short';
    const sizeUsd = parseInt(sizeStr, 10);
    const leverage = parseInt(leverageStr, 10);

    // Store in session for confirmation
    const session: OrderContext = {
      side,
      sizeUsd,
      leverage,
      orderType: 'market',
      step: 'confirm',
    };
    await updateSession(telegramId, session);

    try {
      const hl = await getHyperliquidClient();
      const [price, state] = await Promise.all([
        hl.getGoldPrice(),
        hl.getUserState(user.walletAddress),
      ]);
      const balance = parseFloat(state.marginSummary.accountValue);
      
      const summary = formatTradeCommand({ side, sizeUsd, leverage, orderType: 'market' }, price, balance);
      
      await ctx.editMessageText(
        `🔄 *Copy Trade*\n\n${summary}`,
        { parse_mode: 'Markdown', ...confirmOrderKeyboard() }
      );
    } catch (error) {
      await ctx.editMessageText('Error loading trade. Please try again.', mainMenuKeyboard());
    }
  });
}

// Handler helper functions
async function handleSideSelection(ctx: Context, side: 'long' | 'short') {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) {
    await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
    return;
  }

  const session: OrderContext = { side, step: 'select_size' };
  await updateSession(telegramId, session);

  const sideEmoji = side === 'long' ? '📈' : '📉';
  await ctx.reply(`${sideEmoji} ${side.toUpperCase()} ${TRADING_ASSET}\n\nSelect size:`, sizeSelectionKeyboard());
}

async function handleViewPosition(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const hl = await getHyperliquidClient();
    const position = await hl.getGoldPosition(user.walletAddress);
    const hasPosition = position && parseFloat(position.position.szi) !== 0;

    if (!hasPosition) {
      await ctx.editMessageText(`📊 *No ${TRADING_ASSET} Position*\n\nOpen a position to get started.`, {
        parse_mode: 'Markdown',
        ...positionKeyboard(false),
      });
      return;
    }

    const size = parseFloat(position.position.szi);
    const side = size > 0 ? '📈 LONG' : '📉 SHORT';
    const entry = parseFloat(position.position.entryPx).toFixed(2);
    const pnl = parseFloat(position.position.unrealizedPnl).toFixed(2);
    const pnlEmoji = parseFloat(pnl) >= 0 ? '🟢' : '🔴';
    const leverage = position.position.leverage.value;
    const liqPx = position.position.liquidationPx
      ? `$${parseFloat(position.position.liquidationPx).toFixed(2)}`
      : 'N/A';

    await ctx.editMessageText(
      `📊 *${TRADING_ASSET} Position*\n\n` +
        `${side} ${Math.abs(size).toFixed(4)} ${TRADING_ASSET}\n` +
        `📊 Leverage: ${leverage}x\n` +
        `💵 Entry: $${entry}\n` +
        `${pnlEmoji} Unrealized PnL: $${pnl}\n` +
        `⚠️ Liquidation: ${liqPx}`,
      { parse_mode: 'Markdown', ...positionKeyboard(true) }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
  }
}

async function handleViewOrders(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const hl = await getHyperliquidClient();
    const orders = await hl.getOpenOrders(user.walletAddress);

    if (orders.length === 0) {
      await ctx.editMessageText('📋 *No Open Orders*', {
        parse_mode: 'Markdown',
        ...mainMenuKeyboard(),
      });
      return;
    }

    const orderList = orders
      .map((o) => {
        const side = o.side === 'B' ? '📈 BUY' : '📉 SELL';
        return `${side} ${o.sz} @ $${o.limitPx} (#${o.oid})`;
      })
      .join('\n');

    await ctx.editMessageText(`📋 *Open ${TRADING_ASSET} Orders*\n\n${orderList}`, {
      parse_mode: 'Markdown',
      ...ordersKeyboard(orders.map((o) => o.oid)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
  }
}

async function handleClosePosition(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const hl = await getHyperliquidClient();
    const position = await hl.getGoldPosition(user.walletAddress);

    if (!position || parseFloat(position.position.szi) === 0) {
      await ctx.editMessageText('No position to close.', mainMenuKeyboard());
      return;
    }

    const size = parseFloat(position.position.szi);
    const side = size > 0 ? 'LONG' : 'SHORT';
    const pnl = parseFloat(position.position.unrealizedPnl).toFixed(2);

    await ctx.editMessageText(
      `🔴 *Close Position?*\n\n` +
        `${side} ${Math.abs(size).toFixed(4)} ${TRADING_ASSET}\n` +
        `Current PnL: $${pnl}`,
      { parse_mode: 'Markdown', ...closeConfirmKeyboard() }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
  }
}

async function handleCancelAllOrders(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const hl = await getHyperliquidClient();

    await hl.cancelAllOrders(user.agentPrivateKey, user.walletAddress);
    await ctx.editMessageText('✅ All orders cancelled.', mainMenuKeyboard());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
  }
}

async function handleSettings(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  await ctx.editMessageText('⚙️ *Settings*', {
    parse_mode: 'Markdown',
    ...settingsKeyboard(user.defaultLeverage, user.defaultSizeUsd),
  });
}

async function handleRefresh(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const summary = await getAccountSummary(user.walletAddress, user.points);
    await ctx.editMessageText(summary, {
      parse_mode: 'Markdown',
      ...balanceKeyboard(MINIAPP_URL),
    });
  } catch (error) {
    await ctx.editMessageText('Error refreshing. Please try again.', mainMenuKeyboard());
  }
}

async function handleDetails(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);

  if (!user) return;

  try {
    const summary = await getAccountSummary(user.walletAddress, user.points);
    await ctx.editMessageText(summary, {
      parse_mode: 'Markdown',
      ...balanceKeyboard(MINIAPP_URL),
    });
  } catch (error) {
    await ctx.editMessageText('Error loading details. Please try again.', mainMenuKeyboard());
  }
}

function formatOrderStatus(response: any): string {
  const status = response?.data?.statuses?.[0];
  if (!status) {
    return 'No status returned. Use /orders or /position to verify.';
  }

  if (status.resting?.oid) {
    return `Order ID: #${status.resting.oid}`;
  }

  if (status.filled?.totalSz) {
    return `Filled ${status.filled.totalSz} @ $${status.filled.avgPx}`;
  }

  if (status.error) {
    return `Error: ${status.error}`;
  }

  return `Status: ${JSON.stringify(status)}`;
}

async function handleCancel(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  await clearSession(telegramId);
  await ctx.editMessageText('Cancelled.', mainMenuKeyboard());
}

/**
 * Handle text-based close commands (e.g., "close", "close half")
 */
async function handleCloseText(
  ctx: Context,
  user: { walletAddress: string; agentPrivateKey: string; agentAddress: string },
  fraction: number
) {
  try {
    const hl = await getHyperliquidClient();
    const position = await hl.getGoldPosition(user.walletAddress);

    if (!position || parseFloat(position.position.szi) === 0) {
      await ctx.reply('📊 No position to close.', mainMenuKeyboard());
      return;
    }

    const size = parseFloat(position.position.szi);
    const side = size > 0 ? 'LONG' : 'SHORT';
    const closeSize = Math.abs(size) * fraction;
    const fractionLabel = fraction === 1 ? 'entire' : `${Math.round(fraction * 100)}% of`;

    await ctx.reply(`⏳ Closing ${fractionLabel} position...`);

    const result = await hl.closePartialPosition(user.agentPrivateKey, user.walletAddress, fraction);

    if (result.status === 'ok') {
      const response = result.response?.data?.statuses[0];
      if (response?.filled) {
        await ctx.replyWithMarkdown(
          `✅ *Position Closed*\n\n` +
            `${side} ${response.filled.totalSz} ${TRADING_ASSET}\n` +
            `Close Price: $${response.filled.avgPx}`,
          mainMenuKeyboard()
        );
      } else {
        await ctx.reply('Position closed.', mainMenuKeyboard());
      }
    } else {
      const errorMsg = result.error || 'Unknown error';
      if (errorMsg.includes('does not exist') || errorMsg.includes('User or API Wallet')) {
        await ctx.replyWithMarkdown(
          `🔐 *Authorization Required*\n\nTap below to authorize trading:`,
          authorizeAgentKeyboard(MINIAPP_URL)
        );
      } else {
        await ctx.reply(`❌ Failed to close: ${errorMsg}`, mainMenuKeyboard());
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('does not exist') || message.includes('User or API Wallet')) {
      await ctx.replyWithMarkdown(
        `🔐 *Authorization Required*\n\nTap below to authorize trading:`,
        authorizeAgentKeyboard(MINIAPP_URL)
      );
    } else {
      await ctx.reply(`❌ Error: ${message}`, mainMenuKeyboard());
    }
  }
}

