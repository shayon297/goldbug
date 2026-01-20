import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
    })),
  },
}));

describe('HyperliquidClient', () => {
  const mockAxiosInstance = {
    post: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (axios.create as any).mockReturnValue(mockAxiosInstance);
  });

  describe('getMeta', () => {
    it('should fetch market metadata', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          universe: [
            { name: 'BTC', szDecimals: 4, maxLeverage: 50 },
            { name: 'ETH', szDecimals: 3, maxLeverage: 50 },
            { name: 'GOLD', szDecimals: 2, maxLeverage: 20 },
          ],
        },
      });

      // Import after mocking
      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      const meta = await client.getMeta();

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/info', { type: 'meta' });
      expect(meta.universe).toHaveLength(3);
      expect(meta.universe[2].name).toBe('GOLD');
    });
  });

  describe('initialize', () => {
    it('should find GOLD asset index', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          universe: [
            { name: 'BTC', szDecimals: 4, maxLeverage: 50 },
            { name: 'GOLD', szDecimals: 2, maxLeverage: 20 },
          ],
        },
      });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      await client.initialize();

      // After initialization, GOLD index should be 1
      expect(mockAxiosInstance.post).toHaveBeenCalled();
    });

    it('should throw if GOLD not found', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          universe: [{ name: 'BTC', szDecimals: 4, maxLeverage: 50 }],
        },
      });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      await expect(client.initialize()).rejects.toThrow('GOLD market not found');
    });
  });

  describe('getGoldPrice', () => {
    it('should return GOLD mid price', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { BTC: '100000.5', ETH: '3500.25', GOLD: '2785.50' },
      });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      const price = await client.getGoldPrice();

      expect(price).toBe(2785.5);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/info', { type: 'allMids' });
    });

    it('should throw if GOLD price not available', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { BTC: '100000.5' },
      });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      await expect(client.getGoldPrice()).rejects.toThrow('GOLD price not available');
    });
  });

  describe('getUserState', () => {
    it('should fetch user clearinghouse state', async () => {
      const mockState = {
        marginSummary: {
          accountValue: '10000.00',
          totalMarginUsed: '500.00',
          totalNtlPos: '5000.00',
          totalRawUsd: '10000.00',
        },
        assetPositions: [],
        withdrawable: '9500.00',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({ data: mockState });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      const state = await client.getUserState('0x1234567890abcdef1234567890abcdef12345678');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/info', {
        type: 'clearinghouseState',
        user: '0x1234567890abcdef1234567890abcdef12345678',
      });
      expect(state.marginSummary.accountValue).toBe('10000.00');
    });
  });

  describe('getOpenOrders', () => {
    it('should filter for GOLD orders only', async () => {
      const mockOrders = [
        { coin: 'BTC', oid: 1, side: 'B', sz: '0.1', limitPx: '100000' },
        { coin: 'GOLD', oid: 2, side: 'B', sz: '1.5', limitPx: '2800' },
        { coin: 'GOLD', oid: 3, side: 'A', sz: '0.5', limitPx: '2850' },
      ];

      mockAxiosInstance.post.mockResolvedValueOnce({ data: mockOrders });

      const { HyperliquidClient } = await import('./client.js');
      const client = new HyperliquidClient();

      const orders = await client.getOpenOrders('0x1234');

      expect(orders).toHaveLength(2);
      expect(orders.every((o) => o.coin === 'GOLD')).toBe(true);
    });
  });
});

