import { Markup } from 'telegraf';

/**
 * Inline keyboard builders for the trading bot
 */

// Connect wallet button (opens Mini App)
export function connectWalletKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🚀 Start Trading', miniAppUrl)],
  ]);
}

// Main trading menu
export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Long', 'action:long'),
      Markup.button.callback('📉 Short', 'action:short'),
    ],
    [
      Markup.button.callback('📊 Position', 'action:position'),
      Markup.button.callback('📋 Orders', 'action:orders'),
    ],
    [
      Markup.button.callback('💰 Fund', 'action:fund'),
      Markup.button.callback('🏦 Withdraw', 'action:withdraw'),
    ],
    [
      Markup.button.callback('⚙️ Settings', 'action:settings'),
      Markup.button.callback('🔄 Refresh', 'action:refresh'),
    ],
  ]);
}

// Unified dashboard keyboard - shows trading + position actions
export function dashboardKeyboard(hasPosition: boolean, miniAppUrl: string) {
  if (hasPosition) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Long', 'action:long'),
        Markup.button.callback('📉 Short', 'action:short'),
      ],
      [Markup.button.callback('🔴 Close Position', 'action:close')],
      [
        Markup.button.callback('📊 Details', 'action:details'),
        Markup.button.webApp('💳 Add Funds', `${miniAppUrl}?action=onramp`),
      ],
    ]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Long', 'action:long'),
      Markup.button.callback('📉 Short', 'action:short'),
    ],
    [
      Markup.button.callback('📊 Details', 'action:details'),
      Markup.button.webApp('💳 Add Funds', `${miniAppUrl}?action=onramp`),
    ],
  ]);
}

// Size selection (4 common sizes + custom)
export function sizeSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('$25', 'size:25'),
      Markup.button.callback('$50', 'size:50'),
      Markup.button.callback('$100', 'size:100'),
      Markup.button.callback('$250', 'size:250'),
    ],
    [
      Markup.button.callback('$500', 'size:500'),
      Markup.button.callback('$1000', 'size:1000'),
      Markup.button.callback('✏️ Custom', 'size:custom'),
    ],
    [Markup.button.callback('❌ Cancel', 'action:cancel')],
  ]);
}

// Leverage selection
export function leverageSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('1x', 'leverage:1'),
      Markup.button.callback('2x', 'leverage:2'),
      Markup.button.callback('3x', 'leverage:3'),
      Markup.button.callback('5x', 'leverage:5'),
    ],
    [
      Markup.button.callback('10x', 'leverage:10'),
      Markup.button.callback('15x', 'leverage:15'),
      Markup.button.callback('20x', 'leverage:20'),
    ],
    [Markup.button.callback('❌ Cancel', 'action:cancel')],
  ]);
}

// Order type selection
export function orderTypeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚡ Market', 'type:market'),
      Markup.button.callback('📝 Limit', 'type:limit'),
    ],
    [Markup.button.callback('❌ Cancel', 'action:cancel')],
  ]);
}

// Order confirmation
export function confirmOrderKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', 'confirm:yes'),
      Markup.button.callback('❌ Cancel', 'confirm:no'),
    ],
  ]);
}

export function balanceKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.webApp('🌉 Bridge USDC', `${miniAppUrl}?action=bridge`),
      Markup.button.webApp('💳 Buy USDC', `${miniAppUrl}?action=onramp`),
    ],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

// After order execution
export function postOrderKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 View Position', 'action:position'),
      Markup.button.callback('🔴 Close Position', 'action:close'),
    ],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

// Position management
export function positionKeyboard(hasPosition: boolean) {
  if (!hasPosition) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Long', 'action:long'),
        Markup.button.callback('📉 Short', 'action:short'),
      ],
      [Markup.button.callback('🏠 Main Menu', 'action:menu')],
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback('🔴 Close Position', 'action:close')],
    [
      Markup.button.callback('📈 Add Long', 'action:long'),
      Markup.button.callback('📉 Add Short', 'action:short'),
    ],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

// Settings menu
export function settingsKeyboard(currentLeverage: number, currentSize: number) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`📊 Default Leverage: ${currentLeverage}x`, 'settings:leverage')],
    [Markup.button.callback(`💰 Default Size: $${currentSize}`, 'settings:size')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

// Open orders list
export function ordersKeyboard(orderIds: number[]) {
  const buttons = orderIds.map((oid) => [
    Markup.button.callback(`❌ Cancel #${oid}`, `cancel_order:${oid}`),
  ]);

  if (orderIds.length > 0) {
    buttons.push([Markup.button.callback('❌ Cancel All Orders', 'action:cancel_all')]);
  }

  buttons.push([Markup.button.callback('🏠 Main Menu', 'action:menu')]);

  return Markup.inlineKeyboard(buttons);
}

// Close confirmation
export function closeConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes, Close Position', 'close:confirm'),
      Markup.button.callback('❌ Cancel', 'action:menu'),
    ],
  ]);
}

// Builder fee approval button (shown when builder fee not approved)
export function approveBuilderFeeKeyboard(miniAppUrl: string) {
  const cacheBuster = Date.now();
  const approvalUrl = `${miniAppUrl.replace(/\/$/, '')}/approve-builder-fee?v=${cacheBuster}`;
  return Markup.inlineKeyboard([
    [Markup.button.webApp('✅ Approve & Trade', approvalUrl)],
    [Markup.button.callback('❌ Cancel', 'confirm:no')],
  ]);
}

// Agent authorization button (shown when agent not approved)
export function authorizeAgentKeyboard(miniAppUrl: string) {
  const cacheBuster = Date.now();
  const approvalUrl = `${miniAppUrl.replace(/\/$/, '')}/approval?v=${cacheBuster}`;
  return Markup.inlineKeyboard([
    [Markup.button.webApp('✅ Authorize Trading', approvalUrl)],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Trade receipt keyboard shown after a trade fills
 * Includes share and copy buttons for viral distribution
 */
export interface TradeReceiptParams {
  side: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  entryPrice: number;
}

export function tradeReceiptKeyboard(params: TradeReceiptParams) {
  // Encode trade params in callback data for share action
  const shareData = `share:${params.side === 'long' ? 'L' : 'S'}_${params.sizeUsd}_${params.leverage}_${Math.round(params.entryPrice)}`;
  const copyData = `copy:${params.side === 'long' ? 'L' : 'S'}_${params.sizeUsd}_${params.leverage}`;
  
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📤 Share Trade', shareData),
      Markup.button.callback('🔄 Copy Setup', copyData),
    ],
    [
      Markup.button.callback('📊 View Position', 'action:position'),
      Markup.button.callback('🔴 Close', 'action:close'),
    ],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Keyboard shown after user copies a shared trade
 * Simpler - just confirm or cancel
 */
export function copiedTradeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Execute Trade', 'confirm:yes'),
      Markup.button.callback('❌ Cancel', 'confirm:no'),
    ],
  ]);
}

// ============================================
// Contextual UX Keyboards
// ============================================

/**
 * Prompt to bridge when user has funds on Arbitrum but not Hyperliquid
 */
export function bridgePromptKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🌉 Bridge USDC Now', `${miniAppUrl}?action=bridge`)],
    [Markup.button.callback('📊 Check Balance', 'action:refresh')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Prompt to fund when user has no funds anywhere
 */
export function fundPromptKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('💳 Buy USDC', `${miniAppUrl}?action=onramp`)],
    [Markup.button.callback('📋 How to Fund', 'action:deposit_help')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Prompt when order size exceeds available margin
 */
export function insufficientMarginKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📉 Use Smaller Size', 'action:long')],
    [Markup.button.webApp('💳 Add More Funds', `${miniAppUrl}?action=onramp`)],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Post-close keyboard with optional withdraw prompt for profits
 */
export function postCloseKeyboard(showWithdraw: boolean) {
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  
  if (showWithdraw) {
    buttons.push([Markup.button.callback('💰 Withdraw Profit', 'action:withdraw')]);
  }
  
  buttons.push([
    Markup.button.callback('📈 New Trade', 'action:long'),
    Markup.button.callback('📉 Short', 'action:short'),
  ]);
  buttons.push([Markup.button.callback('🏠 Main Menu', 'action:menu')]);
  
  return Markup.inlineKeyboard(buttons);
}

/**
 * Post-bridge keyboard prompting user to start trading
 */
export function postBridgeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Long Gold', 'action:long'),
      Markup.button.callback('📉 Short Gold', 'action:short'),
    ],
    [Markup.button.callback('📊 Check Balance', 'action:refresh')],
  ]);
}

/**
 * Post-onramp keyboard prompting user to bridge
 */
export function postOnrampKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🌉 Bridge to Hyperliquid', `${miniAppUrl}?action=bridge`)],
    [Markup.button.callback('📊 Check Balance', 'action:refresh')],
  ]);
}

/**
 * Low balance dashboard - prominently shows funding options
 */
export function lowBalanceDashboardKeyboard(miniAppUrl: string, hasArbFunds: boolean) {
  if (hasArbFunds) {
    return Markup.inlineKeyboard([
      [Markup.button.webApp('🌉 Bridge USDC to Trade', `${miniAppUrl}?action=bridge`)],
      [Markup.button.callback('📊 View Balance', 'action:details')],
    ]);
  }
  
  return Markup.inlineKeyboard([
    [Markup.button.webApp('💳 Fund Account', `${miniAppUrl}?action=onramp`)],
    [Markup.button.callback('📋 How to Fund', 'action:deposit_help')],
  ]);
}

// ============================================
// Deep UX Edge Case Keyboards
// ============================================

/**
 * Gas help keyboard - when user has USDC but no ETH for gas
 */
export function gasHelpKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⛽ Request Gas Drip', 'action:gas_drip')],
    [Markup.button.webApp('💳 Buy ETH', `${miniAppUrl}?action=onramp`)],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * No USDC on Arbitrum - prompt to buy
 */
export function noUsdcKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('💳 Buy USDC', `${miniAppUrl}?action=onramp`)],
    [Markup.button.callback('📋 How to Fund', 'action:deposit_help')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Confirm position reversal (long->short or vice versa)
 */
export function confirmReversalKeyboard(newSide: 'long' | 'short') {
  const sideEmoji = newSide === 'long' ? '📈' : '📉';
  return Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Close & Open ${newSide.toUpperCase()}`, `reversal:confirm:${newSide}`)],
    [Markup.button.callback('❌ Keep Current Position', 'action:menu')],
  ]);
}

/**
 * Post-cancel keyboard - options after cancelling orders
 */
export function postCancelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 New Long', 'action:long'),
      Markup.button.callback('📉 New Short', 'action:short'),
    ],
    [Markup.button.callback('📊 View Position', 'action:position')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

/**
 * Ready to trade keyboard - for users with balance
 */
export function readyToTradeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Long', 'action:long'),
      Markup.button.callback('📉 Short', 'action:short'),
    ],
    [Markup.button.callback('📊 View Chart', 'action:chart')],
    [
      Markup.button.callback('💰 Fund', 'action:fund'),
      Markup.button.callback('🏦 Withdraw', 'action:withdraw'),
    ],
  ]);
}

/**
 * Position actions keyboard - for users with open position
 */
export function positionActionsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔴 Close Position', 'action:close')],
    [
      Markup.button.callback('📈 Add Long', 'action:long'),
      Markup.button.callback('📉 Add Short', 'action:short'),
    ],
    [Markup.button.callback('📊 View Chart', 'action:chart')],
    [
      Markup.button.callback('💰 Fund', 'action:fund'),
      Markup.button.callback('🏦 Withdraw', 'action:withdraw'),
    ],
  ]);
}

/**
 * First trade celebration keyboard
 */
export function firstTradeKeyboard(params: TradeReceiptParams) {
  const shareData = `share:${params.side === 'long' ? 'L' : 'S'}_${params.sizeUsd}_${params.leverage}_${Math.round(params.entryPrice)}`;
  
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Share First Trade!', shareData)],
    [Markup.button.callback('📊 View Chart', 'action:chart')],
    [Markup.button.callback('🏠 Main Menu', 'action:menu')],
  ]);
}

