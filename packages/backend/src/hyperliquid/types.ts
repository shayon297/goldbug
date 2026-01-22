// Hyperliquid API types for GOLD trading

export interface MetaResponse {
  universe: AssetInfo[];
}

export interface AssetInfo {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface UserState {
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  assetPositions: AssetPosition[];
  withdrawable: string;
}

export interface AssetPosition {
  position: {
    coin: string;
    szi: string; // Size (signed, negative for short)
    leverage: {
      type: 'cross' | 'isolated';
      value: number;
    };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    marginUsed: string;
  };
  type: 'oneWay';
}

export interface OpenOrder {
  coin: string;
  limitPx: string;
  oid: number;
  side: 'B' | 'A'; // Buy or Ask (Sell)
  sz: string;
  timestamp: number;
  cloid?: string;
}

export interface UserFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  oid: number;
  fee: string;
}

export interface OrderResult {
  status: 'ok' | 'err';
  response?: {
    type: 'order' | 'cancel';
    data?: {
      statuses: Array<{
        filled?: { totalSz: string; avgPx: string; oid: number };
        resting?: { oid: number };
        error?: string;
      }>;
    };
  };
  error?: string;
}

export interface L1Action {
  type: string;
  [key: string]: unknown;
}

export type OrderSide = 'long' | 'short';
export type OrderType = 'market' | 'limit';

export interface PlaceOrderParams {
  side: OrderSide;
  sizeUsd: number;
  leverage: number;
  orderType: OrderType;
  limitPrice?: number;
}

// EIP-712 signing types for Hyperliquid
export const HYPERLIQUID_DOMAIN = {
  name: 'HyperliquidSignTransaction',
  version: '1',
  chainId: 42161, // Arbitrum
  verifyingContract: '0x0000000000000000000000000000000000000000' as const,
};

export const ORDER_TYPES = {
  Order: [
    { name: 'asset', type: 'uint32' },
    { name: 'isBuy', type: 'bool' },
    { name: 'limitPx', type: 'uint64' },
    { name: 'sz', type: 'uint64' },
    { name: 'reduceOnly', type: 'bool' },
    { name: 'cloid', type: 'bytes16' },
  ],
};

