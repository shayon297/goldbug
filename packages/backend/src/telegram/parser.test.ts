import { describe, it, expect } from 'vitest';
import { parseTradeCommand, validateLeverage, validateSize, sanitizeInput } from './parser.js';

describe('parseTradeCommand', () => {
  it('should parse basic long command', () => {
    const result = parseTradeCommand('Long 5x $1000 market');
    expect(result.success).toBe(true);
    expect(result.command).toEqual({
      side: 'long',
      leverage: 5,
      sizeUsd: 1000,
      orderType: 'market',
      limitPrice: undefined,
    });
  });

  it('should parse basic short command', () => {
    const result = parseTradeCommand('Short 10x $500');
    expect(result.success).toBe(true);
    expect(result.command?.side).toBe('short');
    expect(result.command?.leverage).toBe(10);
    expect(result.command?.sizeUsd).toBe(500);
  });

  it('should parse limit order with price', () => {
    const result = parseTradeCommand('Long 2x $1000 limit 2800');
    expect(result.success).toBe(true);
    expect(result.command?.orderType).toBe('limit');
    expect(result.command?.limitPrice).toBe(2800);
  });

  it('should default to 1x leverage if not specified', () => {
    const result = parseTradeCommand('Long $500');
    expect(result.success).toBe(true);
    expect(result.command?.leverage).toBe(1);
  });

  it('should handle "buy" as long', () => {
    const result = parseTradeCommand('Buy 5x $500');
    expect(result.success).toBe(true);
    expect(result.command?.side).toBe('long');
  });

  it('should handle "sell" as short', () => {
    const result = parseTradeCommand('Sell 3x $250');
    expect(result.success).toBe(true);
    expect(result.command?.side).toBe('short');
  });

  it('should reject leverage over 20x', () => {
    const result = parseTradeCommand('Long 50x $1000');
    expect(result.success).toBe(false);
    expect(result.error).toContain('20x');
  });

  it('should reject missing side', () => {
    const result = parseTradeCommand('5x $1000');
    expect(result.success).toBe(false);
    expect(result.error).toContain('long');
  });

  it('should reject missing size', () => {
    const result = parseTradeCommand('Long 5x');
    expect(result.success).toBe(false);
    expect(result.error).toContain('size');
  });

  it('should reject limit order without price', () => {
    const result = parseTradeCommand('Long 5x $1000 limit');
    expect(result.success).toBe(false);
    expect(result.error).toContain('price');
  });

  it('should handle case insensitivity', () => {
    const result = parseTradeCommand('LONG 5X $1000 MARKET');
    expect(result.success).toBe(true);
    expect(result.command?.side).toBe('long');
  });
});

describe('validateLeverage', () => {
  it('should accept valid leverage', () => {
    expect(validateLeverage(1).valid).toBe(true);
    expect(validateLeverage(10).valid).toBe(true);
    expect(validateLeverage(20).valid).toBe(true);
  });

  it('should reject leverage below 1', () => {
    const result = validateLeverage(0);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Minimum');
  });

  it('should reject leverage above 20', () => {
    const result = validateLeverage(21);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Maximum');
  });

  it('should reject non-integer leverage', () => {
    const result = validateLeverage(5.5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('whole number');
  });
});

describe('validateSize', () => {
  it('should accept valid sizes', () => {
    expect(validateSize(10).valid).toBe(true);
    expect(validateSize(1000).valid).toBe(true);
    expect(validateSize(100000).valid).toBe(true);
  });

  it('should reject size below minimum', () => {
    const result = validateSize(5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Minimum');
  });

  it('should reject size above maximum', () => {
    const result = validateSize(200000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Maximum');
  });
});

describe('sanitizeInput', () => {
  it('should remove dangerous characters', () => {
    expect(sanitizeInput('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
  });

  it('should trim whitespace', () => {
    expect(sanitizeInput('  Long 5x $1000  ')).toBe('Long 5x $1000');
  });

  it('should truncate long strings', () => {
    const longString = 'a'.repeat(300);
    expect(sanitizeInput(longString).length).toBe(200);
  });
});

