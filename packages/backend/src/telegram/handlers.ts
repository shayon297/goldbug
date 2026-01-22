import { Context, Telegraf } from 'telegraf';
import { ethers, Contract } from 'ethers';
import {
  mainMenuKeyboard,
  connectWalletKeyboard,
  sizeSelectionKeyboard,
  leverageSelectionKeyboard,
  orderTypeKeyboard,
  confirmOrderKeyboard,
  postOrderKeyboard,
  positionKeyboard,
  settingsKeyboard,
  ordersKeyboard,
  closeConfirmKeyboard,
} from './keyboards.js';
import { parseTradeCommand, formatTradeCommand, sanitizeInput } from './parser.js';
import {
  getUserByTelegramId,
  userExists,
  getOrCreateSession,
  updateSession,
  clearSession,
  updateUserPreferences,
  type OrderContext,
} from '../state/db.js';
import { getHyperliquidClient, TRADING_ASSET } from '../hyperliquid/client.js';

const MINIAPP_URL = process.env.MINIAPP_URL || 'https://goldbug-miniapp.railway.app';

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
async function getAccountSummary(walletAddress: string): Promise<string> {
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

  return `🏦 *Wallet*\n\`${walletAddress}\`\n\n` +
    `💎 *Hyperliquid*\n💰 Balance: $${balance}\n💵 Withdrawable: $${withdrawable}\n\n` +
    `🔷 *Arbitrum*\n💵 USDC: $${arbUsdc}\n⛽ ETH: ${arbEth}${bridgeHint}\n\n` +
    `📊 *${TRADING_ASSET} Position*\n${positionText}\n\n` +
    `💲 *${TRADING_ASSET} Price*: $${price.toFixed(2)}`;
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
  // /start command
  bot.command('start', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const exists = await userExists(telegramId);

    if (!exists) {
      await ctx.replyWithMarkdown(
        `🥇 *Welcome to ${TRADING_ASSET} Trade*\n\n` +
          `Trade ${TRADING_ASSET} with up to 20x leverage on Hyperliquid.\n\n` +
          '*Features:*\n' +
          '• Long or Short with 1-20x leverage\n' +
          '• Market & Limit orders\n' +
          '• Real-time position tracking\n' +
          '• All from Telegram chat\n\n' +
          '🔐 Connect your wallet to get started:',
        connectWalletKeyboard(MINIAPP_URL)
      );
    } else {
      const user = await getUserByTelegramId(telegramId);
      if (!user) return;

      try {
        const summary = await getAccountSummary(user.walletAddress);
        const welcomeMsg = 
          `🥇 *${TRADING_ASSET} Trading Bot*\n\n` +
          `✅ *Wallet Connected*\n` +
          `\`${formatWalletAddress(user.walletAddress)}\`\n\n` +
          summary;
        await ctx.replyWithMarkdown(welcomeMsg, mainMenuKeyboard());
      } catch (error) {
        await ctx.replyWithMarkdown(
          `🥇 *${TRADING_ASSET} Trading Bot*\n\n` +
          `✅ *Wallet Connected*\n` +
          `\`${formatWalletAddress(user.walletAddress)}\`\n\n` +
          `⚠️ Could not fetch account data. Try /balance`,
          mainMenuKeyboard()
        );
      }
    }
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.replyWithMarkdown(
      `🥇 *${TRADING_ASSET} Trade Bot - Help*\n\n` +
      `*Commands:*\n` +
      `/start - Show main menu & status\n` +
      `/long - Open a LONG position\n` +
      `/short - Open a SHORT position\n` +
      `/position - View current position\n` +
      `/orders - View open orders\n` +
      `/balance - Check account balance\n` +
      `/close - Close your position\n` +
      `/cancel - Cancel all orders\n` +
      `/deposit - How to fund your wallet\n` +
      `/help - Show this help\n\n` +
      `*Quick Commands:*\n` +
      `You can also type natural language:\n` +
      `• "Long 5x $500 market"\n` +
      `• "Short 10x $1000 limit 2800"\n\n` +
      `Type /deposit for funding instructions.`
    );
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
      `💡 *Minimum:* $10 USDC to start trading`
    );
  });

  // /reauth command - re-authorize agent on Hyperliquid
  bot.command('reauth', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    await ctx.replyWithMarkdown(
      `🔑 *Re-authorize Trading Agent*\n\n` +
      `If your trades are failing, you may need to re-authorize your agent wallet on Hyperliquid.\n\n` +
      `Tap below to sign the authorization:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔑 Re-authorize Agent', web_app: { url: `${MINIAPP_URL}?action=reauth` } }],
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

  // /balance command
  bot.command('balance', async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const user = await getUserByTelegramId(telegramId);

    if (!user) {
      await ctx.reply('Please connect your wallet first.', connectWalletKeyboard(MINIAPP_URL));
      return;
    }

    try {
      const summary = await getAccountSummary(user.walletAddress);
      await ctx.replyWithMarkdown(summary, mainMenuKeyboard());
    } catch (error) {
      await ctx.reply('Error fetching balance. Please try again.');
    }
  });

  // /long and /short shortcuts
  bot.command('long', async (ctx) => {
    await handleSideSelection(ctx, 'long');
  });

  bot.command('short', async (ctx) => {
    await handleSideSelection(ctx, 'short');
  });

  // Handle text messages (natural language commands)
  bot.on('text', async (ctx) => {
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

      if (value < 5) {
        await ctx.reply('Minimum size is $5');
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

    // Try to parse as natural language trade command
    const sanitized = sanitizeInput(ctx.message.text);
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

      const summary = formatTradeCommand(parsed.command);
      await ctx.replyWithMarkdown(`*Confirm Order*\n\n${summary}`, confirmOrderKeyboard());
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
      await ctx.editMessageText('Enter custom size (e.g., "$750" or "750"):');
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
    const session = await getOrCreateSession(telegramId);

    session.orderType = orderType;
    session.step = 'confirm';
    await updateSession(telegramId, session);

    if (orderType === 'limit') {
      await ctx.editMessageText('Enter limit price (e.g., "2800"):');
      return;
    }

    const summary = formatTradeCommand({
      side: session.side!,
      sizeUsd: session.sizeUsd!,
      leverage: session.leverage!,
      orderType: session.orderType!,
      limitPrice: session.limitPrice,
    });

    await ctx.editMessageText(`*Confirm Order*\n\n${summary}`, {
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

    await ctx.editMessageText('⏳ Executing order...');

    try {
      const hl = await getHyperliquidClient();

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
          await ctx.editMessageText(
            `✅ *Order Filled*\n\n` +
              `${session.side.toUpperCase()} ${response.filled.totalSz} ${TRADING_ASSET}\n` +
              `Avg Price: $${response.filled.avgPx}`,
            { parse_mode: 'Markdown', ...postOrderKeyboard() }
          );
        } else if (response?.resting) {
          await ctx.editMessageText(
            `📝 *Order Placed*\n\nOrder ID: #${response.resting.oid}`,
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
        await ctx.editMessageText(`❌ Order failed: ${result.error || 'Unknown error'}`, mainMenuKeyboard());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
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
        await ctx.editMessageText(`❌ Failed to close: ${result.error || 'Unknown error'}`, mainMenuKeyboard());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await ctx.editMessageText(`❌ Error: ${message}`, mainMenuKeyboard());
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
    const summary = await getAccountSummary(user.walletAddress);
    await ctx.editMessageText(summary, {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard(),
    });
  } catch (error) {
    await ctx.editMessageText('Error refreshing. Please try again.', mainMenuKeyboard());
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

