import { z } from 'zod';
import { TRADING_ASSET } from '../hyperliquid/client.js';

/**
 * Natural language command parser for trading commands
 * Supports formats like:
 * - "long 15" → Long $15 at 1x market
 * - "long $100 5x" → Long $100 at 5x market
 * - "short 50 2x limit 4800" → Short $50 at 2x, limit $4800
 * - "close" → Close entire position (market)
 * - "close half" → Close 50% of position
 */

const TradeCommandSchema = z.object({
  side: z.enum(['long', 'short']),
  leverage: z.number().int().min(1).max(20),
  sizeUsd: z.number().positive().max(1000000),
  orderType: z.enum(['market', 'limit']),
  limitPrice: z.number().positive().optional(),
});

export type TradeCommand = z.infer<typeof TradeCommandSchema>;

export interface ParseResult {
  success: boolean;
  command?: TradeCommand;
  error?: string;
}

// Close command result
export interface CloseParseResult {
  isClose: boolean;
  fraction: number; // 1.0 for full, 0.5 for half
}

/**
 * Check if the text is a close command
 * Returns { isClose: true, fraction } if it's a close command
 */
export function parseCloseCommand(text: string): CloseParseResult {
  const normalized = text.toLowerCase().trim();
  
  // Match "close", "close all", "close position"
  if (/^close(\s+all|\s+position)?$/i.test(normalized)) {
    return { isClose: true, fraction: 1.0 };
  }
  
  // Match "close half", "close 50%", "close 50"
  if (/^close\s+(half|50%?|1\/2)$/i.test(normalized)) {
    return { isClose: true, fraction: 0.5 };
  }
  
  // Match "close X%" where X is a number
  const percentMatch = normalized.match(/^close\s+(\d+)%?$/);
  if (percentMatch) {
    const percent = parseInt(percentMatch[1], 10);
    if (percent > 0 && percent <= 100) {
      return { isClose: true, fraction: percent / 100 };
    }
  }
  
  return { isClose: false, fraction: 0 };
}

/**
 * Parse a natural language trading command
 * Defaults: 1x leverage, market order
 */
export function parseTradeCommand(text: string): ParseResult {
  const normalized = text.toLowerCase().trim();

  // Extract side (long/short)
  let side: 'long' | 'short' | null = null;
  if (normalized.includes('long') || normalized.includes('buy')) {
    side = 'long';
  } else if (normalized.includes('short') || normalized.includes('sell')) {
    side = 'short';
  }

  if (!side) {
    return { success: false, error: 'Specify "long" or "short"' };
  }

  // Extract leverage (e.g., "5x", "10x") - defaults to 1x
  const leverageMatch = normalized.match(/(\d{1,2})x/);
  const leverage = leverageMatch ? parseInt(leverageMatch[1], 10) : 1;

  if (leverage < 1 || leverage > 20) {
    return { success: false, error: 'Leverage must be between 1x and 20x' };
  }

  // Extract size (e.g., "$1000", "1000", "$500")
  // Be smarter about finding the size - exclude leverage values
  const allNumbers = normalized.match(/\$?\d+(?:\.\d{1,2})?/g) || [];
  let sizeUsd: number | null = null;

  // Prefer explicitly $-prefixed values
  const dollarValue = allNumbers.find((match) => match.startsWith('$'));
  if (dollarValue) {
    sizeUsd = parseFloat(dollarValue.replace('$', ''));
  } else {
    // Find a number that isn't the leverage value
    for (const match of allNumbers) {
      const value = parseFloat(match.replace('$', ''));
      // Skip if this exact string is part of leverage pattern (e.g., "5" in "5x")
      const leveragePattern = new RegExp(`\\b${value}x\\b`, 'i');
      if (!leveragePattern.test(normalized)) {
        sizeUsd = value;
        break;
      }
    }
  }

  if (!sizeUsd) {
    return { success: false, error: 'Specify order size (e.g., "long $50" or "long 50 2x")' };
  }

  if (sizeUsd < 10) {
    return { success: false, error: 'Minimum order size is $10' };
  }

  if (sizeUsd / leverage < 10) {
    const minSize = Math.ceil(leverage * 10);
    return {
      success: false,
      error: `Minimum margin is $10. With ${leverage}x leverage, minimum size is $${minSize}`,
    };
  }

  if (sizeUsd > 100000) {
    return { success: false, error: 'Maximum order size is $100,000' };
  }

  // Extract order type - defaults to market
  let orderType: 'market' | 'limit' = 'market';
  let limitPrice: number | undefined;

  if (normalized.includes('limit')) {
    orderType = 'limit';

    // Try to extract limit price (number after "limit")
    const limitMatch = normalized.match(/limit\s+\$?(\d+(?:\.\d{1,2})?)/);
    if (limitMatch) {
      limitPrice = parseFloat(limitMatch[1]);
    }
  }

  if (orderType === 'limit' && !limitPrice) {
    return { success: false, error: 'Limit orders require a price (e.g., "limit 4800")' };
  }

  // Validate with Zod
  const result = TradeCommandSchema.safeParse({
    side,
    leverage,
    sizeUsd,
    orderType,
    limitPrice,
  });

  if (!result.success) {
    const firstError = result.error.errors[0];
    return { success: false, error: firstError?.message || 'Invalid command' };
  }

  return { success: true, command: result.data };
}

/**
 * Format a trade command for display
 * @param cmd - The trade command
 * @param currentPrice - Optional current price to show
 * @param balance - Optional available balance to show
 */
export function formatTradeCommand(cmd: TradeCommand, currentPrice?: number, balance?: number): string {
  const sideEmoji = cmd.side === 'long' ? '📈' : '📉';
  const sideText = cmd.side.toUpperCase();
  const typeText = cmd.orderType === 'market' ? 'Market' : `Limit @ $${cmd.limitPrice?.toLocaleString()}`;

  let output = `${sideEmoji} *${sideText}* ${TRADING_ASSET}\n`;
  output += `💵 Size: $${cmd.sizeUsd.toLocaleString()}\n`;
  output += `📊 Leverage: ${cmd.leverage}x\n`;
  output += `⚡ Type: ${typeText}`;
  
  if (currentPrice) {
    output += `\n💲 Current Price: $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  
  if (balance !== undefined) {
    output += `\n💰 Available: $${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  return output;
}

/**
 * Validate leverage input
 */
export function validateLeverage(value: number): { valid: boolean; error?: string } {
  if (!Number.isInteger(value)) {
    return { valid: false, error: 'Leverage must be a whole number' };
  }
  if (value < 1) {
    return { valid: false, error: 'Minimum leverage is 1x' };
  }
  if (value > 20) {
    return { valid: false, error: 'Maximum leverage is 20x' };
  }
  return { valid: true };
}

/**
 * Validate size input
 */
export function validateSize(value: number): { valid: boolean; error?: string } {
  if (value < 10) {
    return { valid: false, error: 'Minimum size is $10' };
  }
  if (value > 100000) {
    return { valid: false, error: 'Maximum size is $100,000' };
  }
  return { valid: true };
}

/**
 * Sanitize user input to prevent injection
 */
export function sanitizeInput(text: string): string {
  // Remove any potentially dangerous characters
  return text
    .replace(/[<>{}[\]\\]/g, '')
    .trim()
    .slice(0, 200); // Max 200 chars
}

/**
 * Deep link payload format for shareable trades
 * Format: trade_{side}_{sizeUsd}_{leverage}_{type}_{timestamp}[_ref_{code}]
 * 
 * Side: L (long) or S (short)
 * Type: M (market) or L (limit)
 * Timestamp: Unix seconds (for expiry check)
 * 
 * Examples:
 * - trade_L_100_5_M_1706300000 = Long $100 5x Market
 * - trade_S_500_10_M_1706300000_ref_abc123 = Short $500 10x with referral
 */

export interface DeepLinkPayload {
  type: 'trade' | 'ref' | 'unknown';
  trade?: {
    side: 'long' | 'short';
    sizeUsd: number;
    leverage: number;
    orderType: 'market' | 'limit';
    timestamp: number;
    referralCode?: string;
  };
  referralCode?: string;
  error?: string;
}

// Deep links expire after 60 minutes
const DEEP_LINK_EXPIRY_SECONDS = 60 * 60;

/**
 * Parse a deep link payload from /start command
 * Returns structured data or error
 */
export function parseDeepLink(payload: string): DeepLinkPayload {
  if (!payload || payload.trim() === '') {
    return { type: 'unknown' };
  }

  const parts = payload.split('_');

  // Check for referral-only link: ref_CODE
  if (parts[0] === 'ref' && parts.length >= 2) {
    return {
      type: 'ref',
      referralCode: parts[1],
    };
  }

  // Check for trade link: trade_L_100_5_M_TIMESTAMP[_ref_CODE]
  if (parts[0] === 'trade' && parts.length >= 6) {
    const sideCode = parts[1];
    const sizeUsd = parseInt(parts[2], 10);
    const leverage = parseInt(parts[3], 10);
    const typeCode = parts[4];
    const timestamp = parseInt(parts[5], 10);

    // Validate side
    const side = sideCode === 'L' ? 'long' : sideCode === 'S' ? 'short' : null;
    if (!side) {
      return { type: 'unknown', error: 'Invalid trade side' };
    }

    // Validate size
    if (isNaN(sizeUsd) || sizeUsd < 10 || sizeUsd > 100000) {
      return { type: 'unknown', error: 'Invalid trade size' };
    }

    // Validate leverage
    if (isNaN(leverage) || leverage < 1 || leverage > 20) {
      return { type: 'unknown', error: 'Invalid leverage' };
    }

    // Validate order type
    const orderType = typeCode === 'M' ? 'market' : typeCode === 'L' ? 'limit' : null;
    if (!orderType) {
      return { type: 'unknown', error: 'Invalid order type' };
    }

    // Check expiry (60 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(timestamp) || now - timestamp > DEEP_LINK_EXPIRY_SECONDS) {
      return { type: 'unknown', error: 'This trade link has expired' };
    }

    // Check for referral code
    let referralCode: string | undefined;
    const refIndex = parts.indexOf('ref');
    if (refIndex !== -1 && parts.length > refIndex + 1) {
      referralCode = parts[refIndex + 1];
    }

    return {
      type: 'trade',
      trade: {
        side,
        sizeUsd,
        leverage,
        orderType,
        timestamp,
        referralCode,
      },
    };
  }

  return { type: 'unknown' };
}

/**
 * Generate a deep link payload for a trade
 * Format: trade_{side}_{sizeUsd}_{leverage}_{type}_{timestamp}
 */
export function generateTradeDeepLink(
  side: 'long' | 'short',
  sizeUsd: number,
  leverage: number,
  orderType: 'market' | 'limit' = 'market',
  referralCode?: string
): string {
  const sideCode = side === 'long' ? 'L' : 'S';
  const typeCode = orderType === 'market' ? 'M' : 'L';
  const timestamp = Math.floor(Date.now() / 1000);

  let payload = `trade_${sideCode}_${sizeUsd}_${leverage}_${typeCode}_${timestamp}`;
  
  if (referralCode) {
    payload += `_ref_${referralCode}`;
  }

  return payload;
}

/**
 * Format a trade receipt for sharing
 * Returns a nicely formatted message with the deep link
 */
export function formatTradeReceipt(
  side: 'long' | 'short',
  sizeUsd: number,
  leverage: number,
  entryPrice: number,
  botUsername: string,
  referralCode?: string
): string {
  const sideEmoji = side === 'long' ? '📈' : '📉';
  const sideText = side.toUpperCase();
  const deepLink = generateTradeDeepLink(side, sizeUsd, leverage, 'market', referralCode);
  const link = `https://t.me/${botUsername}?start=${deepLink}`;

  return (
    `${sideEmoji} *${sideText}* ${TRADING_ASSET} @ ${leverage}x\n\n` +
    `💵 Size: $${sizeUsd.toLocaleString()}\n` +
    `💲 Entry: $${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
    `👉 Copy this trade:\n${link}`
  );
}

