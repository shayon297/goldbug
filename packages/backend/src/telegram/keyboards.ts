import { Markup } from 'telegraf';

/**
 * Inline keyboard builders for the trading bot
 */

// Connect wallet button (opens Mini App)
export function connectWalletKeyboard(miniAppUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🔗 Connect Wallet', miniAppUrl)],
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

// Size selection
export function sizeSelectionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('$100', 'size:100'),
      Markup.button.callback('$250', 'size:250'),
      Markup.button.callback('$500', 'size:500'),
    ],
    [
      Markup.button.callback('$1000', 'size:1000'),
      Markup.button.callback('$2500', 'size:2500'),
      Markup.button.callback('Custom', 'size:custom'),
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
    [Markup.button.webApp('💸 Approve Builder Fee', approvalUrl)],
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

