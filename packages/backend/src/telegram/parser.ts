import { z } from 'zod';
import { TRADING_ASSET } from '../hyperliquid/client.js';

/**
 * Natural language command parser for trading commands
 * Supports formats like:
 * - "Long 5x $1000 market"
 * - "Short 2x $500 limit 2800"
 * - "long 10x 1000"
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

/**
 * Parse a natural language trading command
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

  // Extract leverage (e.g., "5x", "10x")
  const leverageMatch = normalized.match(/(\d{1,2})x/);
  const leverage = leverageMatch ? parseInt(leverageMatch[1], 10) : 1;

  if (leverage < 1 || leverage > 20) {
    return { success: false, error: 'Leverage must be between 1x and 20x' };
  }

  // Extract size (e.g., "$1000", "1000", "$500")
  const sizeMatch = normalized.match(/\$?\d+(?:\.\d{1,2})?/g);
  let sizeUsd: number | null = null;

  if (sizeMatch) {
    // Prefer explicitly $-prefixed values
    const dollarValue = sizeMatch.find((match) => match.startsWith('$'));
    if (dollarValue) {
      sizeUsd = parseFloat(dollarValue.replace('$', ''));
    } else {
      // Otherwise pick a value that is not the leverage
      for (const match of sizeMatch) {
        const value = parseFloat(match.replace('$', ''));
        if (value !== leverage) {
          sizeUsd = value;
          break;
        }
      }
      // If only leverage is present, fallback to the single number
      if (!sizeUsd && sizeMatch.length === 1) {
        sizeUsd = parseFloat(sizeMatch[0].replace('$', ''));
      }
    }
  }

  if (!sizeUsd) {
    return { success: false, error: 'Specify order size (e.g., "$500")' };
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

  // Extract order type
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
    return { success: false, error: 'Limit orders require a price (e.g., "limit 2800")' };
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
 */
export function formatTradeCommand(cmd: TradeCommand): string {
  const sideEmoji = cmd.side === 'long' ? '📈' : '📉';
  const sideText = cmd.side.toUpperCase();
  const typeText = cmd.orderType === 'market' ? 'Market' : `Limit @ $${cmd.limitPrice}`;

  return `${sideEmoji} ${sideText} ${TRADING_ASSET}\n💰 Size: $${cmd.sizeUsd}\n📊 Leverage: ${cmd.leverage}x\n⚡ Type: ${typeText}`;
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

