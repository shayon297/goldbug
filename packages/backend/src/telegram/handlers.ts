import { Context, Telegraf, Markup } from 'telegraf';
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
  bridgePromptKeyboard,
  fundPromptKeyboard,
  insufficientMarginKeyboard,
  postCloseKeyboard,
  lowBalanceDashboardKeyboard,
  gasHelpKeyboard,
  noUsdcKeyboard,
  confirmReversalKeyboard,
  postCancelKeyboard,
  readyToTradeKeyboard,
  positionActionsKeyboard,
  firstTradeKeyboard,
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
const MIN_TRADE_BALANCE = 10; // Minimum $10 to trade

/**
 * Pre-trade check result for UX guidance
 */
interface PreTradeCheckResult {
  canTrade: boolean;
  hlBalance: number;
  arbBalance: number;
  requiredMargin: number;
  message?: string;
  action?: 'bridge' | 'fund' | 'reduce_size';
}

/**
 * Check if user can trade and provide guidance if not
 */
async function getPreTradeCheck(
  walletAddress: string,
  sizeUsd: number,
  leverage: number
): Promise<PreTradeCheckResult> {
  const hl = await getHyperliquidClient();
  
  const [state, arbBalances] = await Promise.all([
    hl.getUserState(walletAddress),
    getArbitrumBalances(walletAddress),
  ]);
  
  const hlBalance = parseFloat(state.marginSummary.accountValue);
  const arbBalance = parseFloat(arbBalances.usdc);
  const requiredMargin = sizeUsd / leverage;
  
  // Case 1: No funds on exchange, but has funds in holding → transfer
  if (hlBalance < MIN_TRADE_BALANCE && arbBalance >= 5) {
    return {
      canTrade: false,
      hlBalance,
      arbBalance,
      requiredMargin,
      message: `⚠️ *Transfer Required*\n\n` +
        `You have $${arbBalance.toFixed(2)} in your account.\n` +
        `Transfer it to the exchange to start trading.\n\n` +
        `💡 _This takes ~10 seconds_`,
      action: 'bridge',
    };
  }
  
  // Case 2: No funds anywhere → fund
  if (hlBalance < MIN_TRADE_BALANCE) {
    return {
      canTrade: false,
      hlBalance,
      arbBalance,
      requiredMargin,
      message: `💰 *Fund Your Account*\n\n` +
        `Minimum $${MIN_TRADE_BALANCE} required to trade.\n` +
        `Current balance: $${hlBalance.toFixed(2)}\n\n` +
        `Add funds with card:`,
      action: 'fund',
    };
  }
  
  // Case 3: Insufficient margin for this specific order
  if (hlBalance < requiredMargin) {
    const maxSizeAtLeverage = Math.floor(hlBalance * leverage);
    return {
      canTrade: false,
      hlBalance,
      arbBalance,
      requiredMargin,
      message: `⚠️ *Insufficient Margin*\n\n` +
        `Order requires ~$${requiredMargin.toFixed(0)} margin.\n` +
        `Your balance: $${hlBalance.toFixed(2)}\n\n` +
        `Options:\n` +
        `• Trade up to $${maxSizeAtLeverage} at ${leverage}x\n` +
        `• Add more funds`,
      action: 'reduce_size',
    };
  }
  
  // All checks passed
  return {
    canTrade: true,
    hlBalance,
    arbBalance,
    requiredMargin,
  };
}

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

  // Show transfer prompt if funds in holding but not on exchange
  const needsTransfer = parseFloat(arbBalances.usdc) >= 5 && parseFloat(balance) < 5;
  const transferHint = needsTransfer ? `\n\n⚠️ *Funds available to transfer!*\nTap Fund to move them to the exchange.` : '';

  // Points display
  const pointsDisplay = points !== undefined ? `\n\n⭐ *Goldbug Points*: ${points.toLocaleString()}\n_Share trades to earn rewards_` : '';

  return `💰 *Account Summary*\n\n` +
    `📈 *Exchange Balance*\n💵 Trading: $${balance}\n💸 Withdrawable: $${withdrawable}\n\n` +
    `🏦 *Holding*\n💵 Available: $${arbUsdc}${transferHint}\n\n` +
    `📊 *Gold Position*\n${positionText}\n\n` +
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
      // New user from shared trade link - special message
      if (deepLink.type === 'trade' && deepLink.trade) {
        const { side, sizeUsd, leverage } = deepLink.trade;
        const sideEmoji = side === 'long' ? '📈' : '📉';
        
        await ctx.replyWithMarkdown(
          `${sideEmoji} *Someone shared a trade with you!*\n\n` +
          `*${side.toUpperCase()}* Gold\n` +
          `💵 Size: $${sizeUsd}\n` +
          `📊 Leverage: ${leverage}x\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `*Create your account to copy this trade!*\n\n` +
          `Setup takes 30 seconds:\n` +
          `1️⃣ Create account\n` +
          `2️⃣ Fund with card\n` +
          `3️⃣ Copy the trade\n\n` +
          `👇 *Tap below to start*`,
          connectWalletKeyboard(MINIAPP_URL)
        );
        return;
      }
      
      // New user - compelling welcome for gold CFD traders
      await ctx.replyWithMarkdown(
        `🥇 *Trade Gold. Keep Your Edge.*\n\n` +
        `Tired of MT4 spreads eating your profits?\n\n` +
        `Goldbug gives you:\n` +
        `• *0.01% fees* (vs 0.5%+ on brokers)\n` +
        `• *Up to 20x leverage* on XAU/USD\n` +
        `• *No middleman* — trade on Hyperliquid exchange\n` +
        `• *Instant withdrawals* — your money, always\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*Get started in 3 steps:*\n\n` +
        `1️⃣ Create account (30 sec)\n` +
        `2️⃣ Fund with card or transfer\n` +
        `3️⃣ Start trading gold\n\n` +
        `👇 *Tap below to start*`,
        connectWalletKeyboard(MINIAPP_URL)
      );
      return;
    }
    
    const user = await getUserByTelegramId(telegramId);
    if (!user) return;

    // Handle trade deep link - show prefilled trade confirmation
    if (deepLink.type === 'trade' && deepLink.trade) {
      const { side, sizeUsd, leverage, orderType } = deepLink.trade;

      try {
        const hl = await getHyperliquidClient();
        const [price, state, arbBalances] = await Promise.all([
          hl.getGoldPrice(),
          hl.getUserState(user.walletAddress),
          getArbitrumBalances(user.walletAddress),
        ]);
        const balance = parseFloat(state.marginSummary.accountValue);
        const arbUsdc = parseFloat(arbBalances.usdc);
        const requiredMargin = sizeUsd / leverage;
        
        // Pre-check balance before showing trade
        if (balance < MIN_TRADE_BALANCE && arbUsdc >= 5) {
          await ctx.replyWithMarkdown(
            `📋 *Shared Trade*\n\n` +
            `⚠️ *Transfer Required*\n\n` +
            `You have $${arbUsdc.toFixed(2)} ready to transfer.\n` +
            `Move it to the exchange first to copy this trade.`,
            bridgePromptKeyboard(MINIAPP_URL)
          );
          return;
        }
        
        if (balance < requiredMargin) {
          await ctx.replyWithMarkdown(
            `📋 *Shared Trade*\n\n` +
            `⚠️ *Insufficient Funds*\n\n` +
            `This trade requires ~$${requiredMargin.toFixed(0)} margin.\n` +
            `Your balance: $${balance.toFixed(2)}\n\n` +
            `Fund your account to copy this trade:`,
            fundPromptKeyboard(MINIAPP_URL)
          );
          return;
        }
        
        // Store in session for confirmation
        const session: OrderContext = {
          side,
          sizeUsd,
          leverage,
          orderType,
          step: 'confirm',
        };
        await updateSession(telegramId, session);
        
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
      const [state, position, price, arbBalances] = await Promise.all([
        hl.getUserState(user.walletAddress),
        hl.getGoldPosition(user.walletAddress),
        hl.getGoldPrice(),
        getArbitrumBalances(user.walletAddress),
      ]);

      const balanceNum = parseFloat(state.marginSummary.accountValue);
      const balance = balanceNum.toFixed(2);
      const arbUsdc = parseFloat(arbBalances.usdc);
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

      let dashboard = 
        `🥇 *${TRADING_ASSET} Trading Bot*\n\n` +
        `💰 *Balance:* $${balance}\n` +
        `📊 *Position:* ${positionText}\n` +
        `📋 *Orders:* ${ordersText}\n` +
        `💲 *Price:* $${price.toFixed(2)}`;

      // Low balance warning with contextual action
      const isLowBalance = balanceNum < MIN_TRADE_BALANCE;
      const hasArbFunds = arbUsdc >= 5;
      
      if (isLowBalance && hasArbFunds) {
        dashboard += `\n\n⚠️ *Transfer your $${arbUsdc.toFixed(0)} to start trading!*`;
        await ctx.replyWithMarkdown(dashboard, lowBalanceDashboardKeyboard(MINIAPP_URL, true));
      } else if (isLowBalance && !hasPosition) {
        dashboard += `\n\n⚠️ *Fund your account to start trading*`;
        await ctx.replyWithMarkdown(dashboard, lowBalanceDashboardKeyboard(MINIAPP_URL, false));
      } else {
        await ctx.replyWithMarkdown(dashboard, dashboardKeyboard(hasPosition, MINIAPP_URL));
      }
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
      `🥇 *Goldbug Commands*\n\n` +
      `*Trade:*\n` +
      `\`/long $100 5x\` — Go long on gold\n` +
      `\`/short $50 10x\` — Go short on gold\n` +
      `\`/close\` — Close position\n\n` +
      `*Monitor:*\n` +
      `\`/status\` — Balance & position\n` +
      `\`/chart\` — Price chart\n\n` +
      `*Money:*\n` +
      `\`/fund\` — Add funds\n` +
      `\`/withdraw\` — Cash out to bank\n\n` +
      `*Earn Points:*\n` +
      `Share your trades → Earn ⭐ points\n` +
      `Points unlock future bonuses & discounts\n\n` +
      `💡 _Type naturally: "long 100 5x" works too!_\n\n` +
      `_Powered by Hyperliquid Exchange_`,
      mainMenuKeyboard()
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
      const hl = await getHyperliquidClient();
      const [state, arbBalances, position] = await Promise.all([
        hl.getUserState(user.walletAddress),
        getArbitrumBalances(user.walletAddress),
        hl.getGoldPosition(user.walletAddress),
      ]);

      const summary = await getAccountSummary(user.walletAddress, user.points);
      
      // Determine contextual keyboard based on user state
      const hlBalance = parseFloat(state.marginSummary.accountValue);
      const arbBalance = parseFloat(arbBalances.usdc);
      const hasPosition = position && parseFloat(position.position.szi) !== 0;

      let keyboard;
      if (hasPosition) {
        // User has open position → show position actions
        keyboard = positionActionsKeyboard();
      } else if (hlBalance >= MIN_TRADE_BALANCE) {
        // User has balance and ready to trade
        keyboard = readyToTradeKeyboard();
      } else if (arbBalance >= 5) {
        // User has funds on Arb, needs to bridge
        keyboard = bridgePromptKeyboard(MINIAPP_URL);
      } else {
        // User needs to fund
        keyboard = fundPromptKeyboard(MINIAPP_URL);
      }

      await ctx.replyWithMarkdown(summary, keyboard);
    } catch (error) {
      console.error('[Status] Error:', error);
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
      `Choose an option:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Fund with Card', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
            [{ text: '💸 Transfer to Exchange', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
            [{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
            [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
          ],
        },
      }
    );
  });

  // /price command - show price with trading CTA
  bot.command('price', async (ctx) => {
    try {
      const hl = await getHyperliquidClient();
      const price = await hl.getGoldPrice();
      await ctx.replyWithMarkdown(
        `💲 *${TRADING_ASSET}*: $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
        `Ready to trade?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('📈 Long', 'action:long'),
            Markup.button.callback('📉 Short', 'action:short'),
          ],
          [Markup.button.callback('📊 View Chart', 'action:chart')],
        ])
      );
    } catch (error) {
      await ctx.reply('Error fetching price. Please try again.', mainMenuKeyboard());
    }
  });

  // /chart command - generate price chart (4h view, TradingView style)
  bot.command('chart', async (ctx) => {
    try {
      await ctx.reply('📊 Generating chart...');
      
      const hl = await getHyperliquidClient();
      // 5-minute candles x 48 = 4 hours of data
      const candles = await hl.getCandles('5m', 48);
      
      if (candles.length === 0) {
        await ctx.reply('No chart data available. Please try again later.');
        return;
      }

      const chartBuffer = await generateChartBuffer({
        candles,
        symbol: TRADING_ASSET,
        interval: '5m',
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
      `💰 *How to Fund Your Account*${walletInfo}\n` +
      `*Option 1: Card (Easiest)*\n` +
      `Tap "Fund with Card" to buy with Visa/Mastercard.\n\n` +
      `*Option 2: Crypto Transfer*\n` +
      `Send USDC on Arbitrum to your account address above.\n\n` +
      `💡 *Minimum:* $10 to start trading`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Fund with Card', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
            [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
          ],
        },
      }
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

    try {
      // Pre-check: Does user have USDC on Arbitrum?
      const arbBalance = await getArbitrumBalances(user.walletAddress);
      const usdcBalance = parseFloat(arbBalance.usdc);
      const ethBalance = parseFloat(arbBalance.eth);

      // No USDC on Arbitrum
      if (usdcBalance < 1) {
        await ctx.replyWithMarkdown(
          `💸 *Transfer Funds to Exchange*\n\n` +
          `⚠️ *No funds to transfer*\n\n` +
          `You need to fund your account first.\n` +
          `Current balance: $${usdcBalance.toFixed(2)}\n\n` +
          `Add funds with card:`,
          noUsdcKeyboard(MINIAPP_URL)
        );
        return;
      }

      // No ETH for gas
      if (ethBalance < 0.0001) {
        await ctx.replyWithMarkdown(
          `💸 *Transfer to Exchange*\n\n` +
          `⚠️ *Transaction Fee Required*\n\n` +
          `You have $${usdcBalance.toFixed(2)} ready to transfer.\n` +
          `Need a tiny transaction fee (~$0.01) to proceed.\n\n` +
          `Tap below to get fee covered:`,
          gasHelpKeyboard(MINIAPP_URL)
        );
        return;
      }

      // All good - show transfer button
      await ctx.replyWithMarkdown(
        `💸 *Transfer to Exchange*\n\n` +
        `💵 Available: $${usdcBalance.toFixed(2)}\n` +
        `✓ Ready to transfer\n\n` +
        `Tap below to move funds to the exchange (~10 seconds):`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💸 Transfer Now', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
              [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
            ],
          },
        }
      );
    } catch (error) {
      console.error('[Bridge] Error checking balances:', error);
      await ctx.replyWithMarkdown(
        `💸 *Transfer to Exchange*\n\n` +
        `Tap below to move funds:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💸 Transfer Now', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
            ],
          },
        }
      );
    }
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
      `💳 *Fund Your Account*\n\n` +
      `Add funds with card, bank transfer, or other payment methods.\n` +
      `ID verification may be required depending on your region.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Fund with Card', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
          ],
        },
      }
    );
  });

  // /offramp command - redirect to /withdraw for unified flow
  bot.command('offramp', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    // Use the same unified withdraw flow
    try {
      const hl = await getHyperliquidClient();
      const [hlBalance, arbBalance] = await Promise.all([
        hl.getAccountBalance(user.walletAddress),
        hl.getArbitrumBalance(user.walletAddress),
      ]);

      const hlWithdrawable = parseFloat(hlBalance.withdrawable || '0');
      const arbUsdc = arbBalance.usdc;

      const buttons: any[][] = [];

      // Primary case: Funds on exchange but not ready to withdraw
      if (hlWithdrawable >= 1 && arbUsdc < 1) {
        const message = `🏦 *Withdraw to Bank*\n\n` +
          `⚠️ *Funds on Exchange*\n\n` +
          `To withdraw to your bank:\n` +
          `1️⃣ Move funds from exchange\n` +
          `2️⃣ Withdraw to bank\n\n` +
          `📈 *Exchange:* $${hlWithdrawable.toFixed(2)}\n` +
          `💵 *Ready to withdraw:* $${arbUsdc.toFixed(2)}\n\n` +
          `Tap below to start:`;
        
        await ctx.replyWithMarkdown(message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: `📤 Move $${hlWithdrawable.toFixed(2)} from Exchange`, callback_data: `withdraw:unbridge:${hlWithdrawable}` }],
              [{ text: '« Back', callback_data: 'menu:main' }],
            ],
          },
        });
        return;
      }

      // Case: Ready to withdraw to bank
      if (arbUsdc >= 1) {
        const message = `🏦 *Withdraw to Bank*\n\n` +
          `✅ You have $${arbUsdc.toFixed(2)} ready to withdraw.\n\n` +
          `📈 *Exchange:* $${hlWithdrawable.toFixed(2)}\n` +
          `💵 *Ready to withdraw:* $${arbUsdc.toFixed(2)}\n\n` +
          `Tap below:`;

        buttons.push([{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }]);
        if (hlWithdrawable >= 1) {
          buttons.push([{ text: `📤 Move $${hlWithdrawable.toFixed(2)} More`, callback_data: `withdraw:unbridge:${hlWithdrawable}` }]);
        }
        buttons.push([{ text: '« Back', callback_data: 'menu:main' }]);
        
        await ctx.replyWithMarkdown(message, {
          reply_markup: { inline_keyboard: buttons },
        });
        return;
      }

      // Case: No funds anywhere
      const message = `🏦 *Withdraw to Bank*\n\n` +
        `⚠️ *No funds available*\n\n` +
        `📈 *Exchange:* $${hlWithdrawable.toFixed(2)}\n` +
        `💵 *Ready to withdraw:* $${arbUsdc.toFixed(2)}\n\n` +
        `Minimum $1 required.`;

      await ctx.replyWithMarkdown(message, {
        reply_markup: {
          inline_keyboard: [[{ text: '« Back', callback_data: 'menu:main' }]],
        },
      });
    } catch (e: any) {
      console.error('[Offramp] Error:', e);
      await ctx.reply('❌ Failed to fetch balances. Try again.');
    }
  });

  // /withdraw command - full withdraw flow (Hyperliquid → Arbitrum → fiat)
  bot.command('withdraw', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const hl = await getHyperliquidClient();
      const [hlBalance, arbBalance, position] = await Promise.all([
        hl.getAccountBalance(user.walletAddress),
        hl.getArbitrumBalance(user.walletAddress),
        hl.getGoldPosition(user.walletAddress),
      ]);

      const hlWithdrawable = parseFloat(hlBalance.withdrawable || '0');
      const hlTotal = parseFloat(hlBalance.balance?.toString() || '0');
      const arbUsdc = arbBalance.usdc;
      const hasPosition = position && parseFloat(position.position.szi) !== 0;

      // Show balances
      let message = `🏦 *Withdraw to Bank*\n\n`;
      message += `📈 *Exchange:* $${hlWithdrawable.toFixed(2)}\n`;
      message += `💵 *Ready to withdraw:* $${arbUsdc.toFixed(2)}\n\n`;

      const buttons: any[][] = [];

      // Check if funds are locked in position
      if (hlWithdrawable < 1 && hlTotal > 10 && hasPosition) {
        const positionSize = Math.abs(parseFloat(position.position.szi));
        const entryPrice = parseFloat(position.position.entryPx);
        const pnl = parseFloat(position.position.unrealizedPnl);
        const notional = (positionSize * entryPrice).toFixed(2);
        
        message += `⚠️ *Funds in Open Position*\n`;
        message += `You have ~$${notional} in your ${pnl >= 0 ? 'profitable' : ''} position.\n`;
        message += `Close it first to withdraw.\n\n`;
        
        buttons.push([{ text: '🔴 Close Position to Withdraw', callback_data: 'action:close' }]);
      } else if (hlWithdrawable >= 1) {
        message += `_Step 1:_ Move funds from exchange\n`;
        message += `_Step 2:_ Withdraw to bank\n\n`;
        buttons.push([{ text: `📤 Move $${hlWithdrawable.toFixed(2)} from Exchange`, callback_data: `withdraw:unbridge:${hlWithdrawable}` }]);
      }

      if (arbUsdc >= 1) {
        buttons.push([{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }]);
      }

      if (buttons.length === 0) {
        message += `⚠️ Minimum $1 required to withdraw.`;
      }

      buttons.push([{ text: '« Back', callback_data: 'menu:main' }]);

      await ctx.replyWithMarkdown(message, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (e: any) {
      console.error('[Withdraw] Error:', e);
      await ctx.reply('❌ Failed to fetch balances. Try again.');
    }
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
      case 'chart':
        await handleChart(ctx);
        break;
      case 'deposit_help':
        await handleDepositHelp(ctx);
        break;
      case 'withdraw':
        await handleWithdrawAction(ctx);
        break;
      case 'gas_drip':
        await handleGasDrip(ctx);
        break;
      case 'fund':
        await handleFund(ctx);
        break;
    }
  });

  // Position reversal confirmation handler
  bot.action(/^reversal:confirm:(.+)$/, async (ctx) => {
    const newSide = ctx.match[1] as 'long' | 'short';
    await ctx.answerCbQuery();

    // Continue with the trade flow after confirmation
    const session: OrderContext = { side: newSide, step: 'select_size' };
    const telegramId = BigInt(ctx.from!.id);
    await updateSession(telegramId, session);

    const sideEmoji = newSide === 'long' ? '📈' : '📉';
    await ctx.editMessageText(
      `${sideEmoji} *${newSide.toUpperCase()} ${TRADING_ASSET}*\n\n` +
      `_This will close your current position first._\n\n` +
      `Select size:`,
      { parse_mode: 'Markdown', ...sizeSelectionKeyboard() }
    );
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

    if (orderType === 'limit') {
      await updateSession(telegramId, session);
      await ctx.editMessageText('Enter limit price (e.g., "2800"):');
      return;
    }

    const hl = await getHyperliquidClient();
    const [leverageWarning, price, state] = await Promise.all([
      user ? getLeverageWarning(user.walletAddress, session.leverage!) : Promise.resolve(null),
      hl.getGoldPrice(),
      user ? hl.getUserState(user.walletAddress) : Promise.resolve({ marginSummary: { accountValue: '0' } }),
    ]);
    
    // Store price at creation for drift detection
    session.priceAtCreation = price;
    await updateSession(telegramId, session);
    
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

      // Pre-trade balance check - ensure user has sufficient funds
      const preCheck = await getPreTradeCheck(user.walletAddress, session.sizeUsd, session.leverage);
      if (!preCheck.canTrade) {
        let keyboard;
        if (preCheck.action === 'bridge') {
          keyboard = bridgePromptKeyboard(MINIAPP_URL);
        } else if (preCheck.action === 'fund') {
          keyboard = fundPromptKeyboard(MINIAPP_URL);
        } else {
          keyboard = insufficientMarginKeyboard(MINIAPP_URL);
        }
        await ctx.editMessageText(preCheck.message!, { parse_mode: 'Markdown', ...keyboard });
        return;
      }

      // Price drift check - warn if price moved >2% since order creation
      if (session.priceAtCreation && session.orderType === 'market') {
        const currentPrice = await hl.getGoldPrice();
        const priceDrift = Math.abs((currentPrice - session.priceAtCreation) / session.priceAtCreation);
        
        if (priceDrift > 0.02) {
          const driftPercent = (priceDrift * 100).toFixed(1);
          const direction = currentPrice > session.priceAtCreation ? '📈 up' : '📉 down';
          
          // Store that we've shown the warning to not loop
          session.priceAtCreation = currentPrice;
          await updateSession(telegramId, session);
          
          await ctx.editMessageText(
            `⚠️ *Price Moved*\n\n` +
            `Price when you started: $${session.priceAtCreation.toLocaleString()}\n` +
            `Current price: $${currentPrice.toLocaleString()}\n` +
            `Change: ${direction} ${driftPercent}%\n\n` +
            `Continue with order at current price?`,
            { parse_mode: 'Markdown', ...confirmOrderKeyboard() }
          );
          return;
        }
      }

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
          
          // Prepare trade receipt params
          const receiptParams = {
            side: session.side,
            sizeUsd: session.sizeUsd,
            leverage: session.leverage,
            entryPrice: avgPrice,
          };
          
          // First trade celebration!
          if (isFirstTrade) {
            await ctx.editMessageText(
              `🎉 *First Trade Complete!*\n\n` +
              `Welcome to gold trading on Hyperliquid!\n\n` +
              `${sideEmoji} *${session.side.toUpperCase()}* ${totalSz.toFixed(4)} ${TRADING_ASSET}\n` +
              `💵 Entry: $${avgPrice.toLocaleString()}\n` +
              `📊 Leverage: ${session.leverage}x\n` +
              `💰 Notional: $${notionalUsd}\n\n` +
              `💡 *Quick Tips:*\n` +
              `• /chart — view price action\n` +
              `• /close — exit your position\n` +
              `• Share trades → earn ⭐ points\n\n` +
              `Good luck! 🍀`,
              { parse_mode: 'Markdown', ...firstTradeKeyboard(receiptParams) }
            );
          } else {
            // Use trade receipt keyboard with share/copy buttons
            const receiptKeyboard = tradeReceiptKeyboard(receiptParams);
            
            await ctx.editMessageText(
              `✅ *Order Filled*\n\n` +
                `${sideEmoji} *${session.side.toUpperCase()}* ${totalSz.toFixed(4)} ${TRADING_ASSET}\n` +
                `💵 Entry: $${avgPrice.toLocaleString()}\n` +
                `📊 Leverage: ${session.leverage}x\n` +
                `💰 Notional: $${notionalUsd}`,
              { parse_mode: 'Markdown', ...receiptKeyboard }
            );
          }
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

      console.log(`[Close] Attempting to close position for ${user.walletAddress}`);
      const result = await hl.closePosition(user.agentPrivateKey, user.walletAddress);
      console.log(`[Close] Result:`, JSON.stringify(result, null, 2));

      if (result.status === 'ok') {
        const response = result.response?.data?.statuses[0];
        console.log(`[Close] Response status:`, JSON.stringify(response, null, 2));
        
        if (response?.filled) {
          // Calculate realized PnL for profit prompt
          const closedPnl = parseFloat(response.filled.closedPnl || '0');
          const hasProfit = closedPnl > 1; // Only prompt for > $1 profit
          
          let closeMessage = `✅ *Position Closed*\n\n` +
            `Size: ${response.filled.totalSz} ${TRADING_ASSET}\n` +
            `Close Price: $${response.filled.avgPx}`;
          
          if (closedPnl !== 0) {
            const pnlEmoji = closedPnl >= 0 ? '🟢' : '🔴';
            const pnlSign = closedPnl >= 0 ? '+' : '';
            closeMessage += `\n${pnlEmoji} *Realized PnL: ${pnlSign}$${closedPnl.toFixed(2)}*`;
          }
          
          if (hasProfit) {
            closeMessage += `\n\n💰 Withdraw your profit to bank?`;
          }
          
          await ctx.editMessageText(closeMessage, { 
            parse_mode: 'Markdown', 
            ...postCloseKeyboard(hasProfit) 
          });
        } else if (response?.resting) {
          // Order is resting (limit order waiting to fill)
          await ctx.editMessageText(
            `📝 *Close Order Placed*\n\n` +
              `Order #${response.resting.oid} waiting to fill.\n` +
              `Check /orders to see status.`,
            { parse_mode: 'Markdown', ...mainMenuKeyboard() }
          );
        } else if (response?.error) {
          await ctx.editMessageText(`❌ Close failed: ${response.error}`, mainMenuKeyboard());
        } else {
          // Fallback - check if position is actually closed
          const position = await hl.getGoldPosition(user.walletAddress);
          if (!position || parseFloat(position.position.szi) === 0) {
            await ctx.editMessageText('✅ Position closed.', postCloseKeyboard(false));
          } else {
            await ctx.editMessageText('⚠️ Close order submitted. Check /status to verify.', mainMenuKeyboard());
          }
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

  // Withdraw/unbridge from Hyperliquid to Arbitrum
  bot.action(/^withdraw:unbridge:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.editMessageText('Please connect your wallet first.');
      return;
    }

    const amount = parseFloat(ctx.match[1]);
    if (isNaN(amount) || amount < 1) {
      await ctx.editMessageText('❌ Invalid withdrawal amount.');
      return;
    }

    await ctx.editMessageText(`⏳ Moving $${amount.toFixed(2)} from exchange...`);

    try {
      const hl = await getHyperliquidClient();
      
      console.log(`[Withdraw] Unbridging ${amount} USDC for ${user.walletAddress}`);
      const result = await hl.withdraw(user.agentPrivateKey, user.walletAddress, amount);
      console.log(`[Withdraw] Result:`, JSON.stringify(result, null, 2));

      if (result.status === 'ok') {
        await ctx.editMessageText(
          `✅ *Funds Moving*\n\n` +
          `$${amount.toFixed(2)} is being moved from the exchange.\n\n` +
          `⏱️ Takes 1-5 minutes. Then tap below to withdraw to bank:\n`,
          { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
                [{ text: '🔄 Refresh Balance', callback_data: 'menu:refresh_withdraw' }],
              ],
            },
          }
        );
      } else {
        const errorMsg = result.error || 'Unknown error';
        await ctx.editMessageText(`❌ Withdrawal failed: ${errorMsg}`, mainMenuKeyboard());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Withdraw] Error:', message);
      await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
    }
  });

  // Refresh withdraw balance
  bot.action('menu:refresh_withdraw', async (ctx) => {
    await ctx.answerCbQuery('Refreshing...');
    
    const telegramId = BigInt(ctx.from!.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) return;

    try {
      const hl = await getHyperliquidClient();
      const arbBalance = await hl.getArbitrumBalance(user.walletAddress);

      await ctx.editMessageText(
        `🔷 *Arbitrum Balance*\n\n` +
        `💵 USDC: $${arbBalance.usdc.toFixed(2)}\n` +
        `⛽ ETH: ${arbBalance.eth.toFixed(4)}\n\n` +
        `Ready to sell? Tap below:`,
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏦 Sell USDC to Fiat', web_app: { url: `${MINIAPP_URL}?action=offramp` } }],
              [{ text: '🔄 Refresh', callback_data: 'menu:refresh_withdraw' }],
              [{ text: '« Back', callback_data: 'menu:main' }],
            ],
          },
        }
      );
    } catch (e: any) {
      console.error('[RefreshWithdraw] Error:', e);
      await ctx.editMessageText('❌ Failed to refresh. Try again.');
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
        await ctx.editMessageText(
          `✅ *Order #${orderId} cancelled*\n\n` +
          `What would you like to do next?`,
          { parse_mode: 'Markdown', ...postCancelKeyboard() }
        );
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

  // Pre-check: ensure user has minimum balance to trade
  try {
    const hl = await getHyperliquidClient();
    const [state, arbBalances, position] = await Promise.all([
      hl.getUserState(user.walletAddress),
      getArbitrumBalances(user.walletAddress),
      hl.getGoldPosition(user.walletAddress),
    ]);
    
    const hlBalance = parseFloat(state.marginSummary.accountValue);
    const arbBalance = parseFloat(arbBalances.usdc);
    
    // Case 1: Has funds on Arbitrum but not on Hyperliquid → prompt bridge
    if (hlBalance < MIN_TRADE_BALANCE && arbBalance >= 5) {
      await ctx.reply(
        `⚠️ *Bridge Required*\n\n` +
        `You have $${arbBalance.toFixed(2)} USDC on Arbitrum.\n` +
        `Bridge it to Hyperliquid to start trading.\n\n` +
        `💡 _This takes ~10 seconds_`,
        { parse_mode: 'Markdown', ...bridgePromptKeyboard(MINIAPP_URL) }
      );
      return;
    }
    
    // Case 2: No funds anywhere → prompt to fund
    if (hlBalance < MIN_TRADE_BALANCE) {
      await ctx.reply(
        `💰 *Fund Your Account*\n\n` +
        `Minimum $${MIN_TRADE_BALANCE} required to trade.\n` +
        `Current balance: $${hlBalance.toFixed(2)}\n\n` +
        `Add funds with card:`,
        { parse_mode: 'Markdown', ...fundPromptKeyboard(MINIAPP_URL) }
      );
      return;
    }

    // Case 3: Position reversal warning (user has LONG and is trying to SHORT, or vice versa)
    if (position && parseFloat(position.position.szi) !== 0) {
      const positionSize = parseFloat(position.position.szi);
      const currentSide = positionSize > 0 ? 'long' : 'short';
      
      if (currentSide !== side) {
        const pnl = parseFloat(position.position.unrealizedPnl);
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        const pnlSign = pnl >= 0 ? '+' : '';
        const absSize = Math.abs(positionSize);
        
        await ctx.reply(
          `⚠️ *Position Reversal*\n\n` +
          `You have an open *${currentSide.toUpperCase()}* position:\n` +
          `📊 Size: ${absSize.toFixed(4)} ${TRADING_ASSET}\n` +
          `${pnlEmoji} PnL: ${pnlSign}$${pnl.toFixed(2)}\n\n` +
          `Opening a *${side.toUpperCase()}* will first close your current position.\n\n` +
          `Continue?`,
          { parse_mode: 'Markdown', ...confirmReversalKeyboard(side) }
        );
        return;
      }
    }
  } catch (error) {
    console.error('[PreTradeCheck] Error in handleSideSelection:', error);
    // Continue with order flow if check fails - will be caught at execution
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
    await ctx.editMessageText(
      `✅ *All orders cancelled*\n\n` +
      `What would you like to do next?`,
      { parse_mode: 'Markdown', ...postCancelKeyboard() }
    );
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

async function handleChart(ctx: Context) {
  try {
    await ctx.answerCbQuery('Generating chart...');
    
    const hl = await getHyperliquidClient();
    // 5-minute candles x 48 = 4 hours of data
    const candles = await hl.getCandles('5m', 48);
    
    if (candles.length === 0) {
      await ctx.reply('No chart data available. Please try again later.');
      return;
    }

    const chartBuffer = await generateChartBuffer({
      candles,
      symbol: TRADING_ASSET,
      interval: '5m',
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
    await ctx.reply('Error generating chart. Please try again later.', mainMenuKeyboard());
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

/**
 * Handle deposit help action - show funding instructions
 */
async function handleDepositHelp(ctx: Context) {
  await ctx.answerCbQuery();
  
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);
  
  let walletInfo = '';
  if (user) {
    walletInfo = `\n\n💳 *Your Wallet:*\n\`${user.walletAddress}\``;
  }
  
  await ctx.editMessageText(
    `💰 *How to Fund Your Wallet*${walletInfo}\n\n` +
    `*Option 1: Buy with Card*\n` +
    `• Tap "Buy USDC" below\n` +
    `• Use card, bank transfer, Apple Pay, etc.\n` +
    `• USDC arrives on Arbitrum (~5 min)\n` +
    `• Bridge to Hyperliquid to trade\n\n` +
    `*Option 2: Send Crypto*\n` +
    `• Send USDC to your wallet address above\n` +
    `• Use *Arbitrum One* network\n` +
    `• Then bridge to Hyperliquid\n\n` +
    `💡 *Minimum:* $10 to start trading`,
    { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Buy USDC', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
          [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
        ],
      },
    }
  );
}

/**
 * Handle gas drip request - sends small amount of ETH for gas
 */
async function handleGasDrip(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);
  
  if (!user) {
    await ctx.editMessageText('Please connect your wallet first.');
    return;
  }
  
  try {
    // Call the gas drip endpoint
    const API_URL = process.env.API_URL || 'http://localhost:3001';
    const response = await fetch(`${API_URL}/api/gas-drip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: user.walletAddress }),
    });
    
    if (response.ok) {
      await ctx.editMessageText(
        `⛽ *Gas Sent!*\n\n` +
        `A small amount of ETH for gas has been sent to your wallet.\n` +
        `It should arrive in ~30 seconds.\n\n` +
        `Wallet: \`${user.walletAddress}\`\n\n` +
        `_You can now bridge your USDC._`,
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🌉 Bridge Now', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
              [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
            ],
          },
        }
      );
    } else {
      const err = await response.json() as { error?: string };
      await ctx.editMessageText(
        `⚠️ *Gas Drip Unavailable*\n\n` +
        `${err.error || 'Unable to send gas right now.'}\n\n` +
        `Try buying ETH directly:`,
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Buy ETH', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
              [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
            ],
          },
        }
      );
    }
  } catch (error) {
    console.error('[GasDrip] Error:', error);
    await ctx.editMessageText(
      `⚠️ *Gas Drip Error*\n\n` +
      `Something went wrong. Try buying ETH directly:`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Buy ETH', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
            [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
          ],
        },
      }
    );
  }
}

/**
 * Handle withdraw action from callback buttons
 */
async function handleWithdrawAction(ctx: Context) {
  await ctx.answerCbQuery();
  
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);
  
  if (!user) {
    await ctx.editMessageText('Please connect your wallet first.');
    return;
  }
  
  try {
    const hl = await getHyperliquidClient();
    const [hlBalance, arbBalance, position] = await Promise.all([
      hl.getAccountBalance(user.walletAddress),
      hl.getArbitrumBalance(user.walletAddress),
      hl.getGoldPosition(user.walletAddress),
    ]);

    const hlWithdrawable = parseFloat(hlBalance.withdrawable || '0');
    const hlTotal = parseFloat(hlBalance.balance?.toString() || '0');
    const arbUsdc = arbBalance.usdc;
    const hasPosition = position && parseFloat(position.position.szi) !== 0;

    let message = `🏦 *Withdraw to Bank*\n\n`;
    message += `📈 *Exchange:* $${hlWithdrawable.toFixed(2)}\n`;
    message += `💵 *Ready to withdraw:* $${arbUsdc.toFixed(2)}\n\n`;

    const buttons: any[][] = [];

    // Check if funds are locked in position
    if (hlWithdrawable < 1 && hlTotal > 10 && hasPosition) {
      const positionSize = Math.abs(parseFloat(position.position.szi));
      const entryPrice = parseFloat(position.position.entryPx);
      const pnl = parseFloat(position.position.unrealizedPnl);
      const notional = (positionSize * entryPrice).toFixed(2);
      
      message += `⚠️ *Funds in Open Position*\n`;
      message += `You have ~$${notional} in your ${pnl >= 0 ? 'profitable' : ''} position.\n`;
      message += `Close it first to withdraw.\n\n`;
      
      buttons.push([{ text: '🔴 Close Position to Withdraw', callback_data: 'action:close' }]);
    } else if (hlWithdrawable >= 1) {
      message += `_Step 1:_ Move funds from exchange\n`;
      message += `_Step 2:_ Withdraw to bank\n\n`;
      buttons.push([{ text: `📤 Move $${hlWithdrawable.toFixed(2)} from Exchange`, callback_data: `withdraw:unbridge:${hlWithdrawable}` }]);
    }

    if (arbUsdc >= 1) {
      buttons.push([{ text: '🏦 Withdraw to Bank', web_app: { url: `${MINIAPP_URL}?action=offramp` } }]);
    }

    if (buttons.length === 0) {
      message += `⚠️ Minimum $1 required to withdraw.`;
    }

    buttons.push([{ text: '🏠 Main Menu', callback_data: 'action:menu' }]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (e: any) {
    console.error('[WithdrawAction] Error:', e);
    await ctx.editMessageText('❌ Failed to fetch balances. Try again.', mainMenuKeyboard());
  }
}

/**
 * Handle fund action (from callback button)
 */
async function handleFund(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getUserByTelegramId(telegramId);
  
  if (!user) {
    await ctx.editMessageText('Please create your account first.');
    return;
  }
  
  await ctx.editMessageText(
    `💰 *Fund Your Account*\n\n` +
    `Choose how to add funds:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Fund with Card', web_app: { url: `${MINIAPP_URL}?action=onramp` } }],
          [{ text: '💸 Transfer to Exchange', web_app: { url: `${MINIAPP_URL}?action=bridge` } }],
          [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
        ],
      },
    }
  );
}

