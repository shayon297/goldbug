import axios, { AxiosInstance } from 'axios';
import { ethers, Wallet } from 'ethers';
import * as msgpack from '@msgpack/msgpack';
import type {
  MetaResponse,
  UserState,
  OpenOrder,
  OrderResult,
  PlaceOrderParams,
  AssetPosition,
} from './types.js';

/**
 * Trading asset configuration for HIP-3 builder perps
 * Format: "dex:COIN" (e.g., "xyz:GOLD") or just "COIN" for native perps
 */
export const TRADING_ASSET = process.env.TRADING_ASSET || 'xyz:GOLD';
const SLIPPAGE_BPS = 100; // 1% slippage for market orders

// Parse dex and coin from TRADING_ASSET
function parseAssetConfig(asset: string): { dex: string | null; coin: string; fullName: string } {
  if (asset.includes(':')) {
    const [dex, coin] = asset.split(':');
    return { dex, coin, fullName: asset };
  }
  return { dex: null, coin: asset, fullName: asset };
}

const ASSET_CONFIG = parseAssetConfig(TRADING_ASSET);

/**
 * Sign an L1 action for Hyperliquid using the phantom agent scheme
 * This is used when an agent wallet signs on behalf of a master wallet
 */
async function signL1Action(
  wallet: Wallet,
  action: Record<string, unknown>,
  activePool: string | null,
  nonce: number
): Promise<{ r: string; s: string; v: number }> {
  // Hyperliquid L1 action signing:
  // 1. Encode the action as msgpack
  // 2. Create the phantom agent data structure
  // 3. Hash it with keccak256
  // 4. Sign the hash

  // Encode action as msgpack
  const actionBytes = msgpack.encode(action);
  const actionHash = ethers.keccak256(actionBytes);

  // Create the phantom agent message
  // Format: keccak256(actionHash + activePool + nonce)
  const connectionId = activePool
    ? ethers.keccak256(ethers.toUtf8Bytes(activePool))
    : ethers.zeroPadValue('0x00', 32);

  // For phantom agent signing, we sign: keccak256(actionHash || connectionId || nonce as 8 bytes)
  const nonceBytes = ethers.zeroPadValue(ethers.toBeHex(nonce), 8);
  const toSign = ethers.keccak256(ethers.concat([actionHash, connectionId, nonceBytes]));

  // Sign the hash
  const signature = wallet.signingKey.sign(toSign);

  return {
    r: signature.r,
    s: signature.s,
    v: signature.v,
  };
}

/**
 * Format a float to a string, removing trailing zeros
 * This is important for Hyperliquid's signature verification
 */
function floatToWire(x: number): string {
  const formatted = x.toFixed(8);
  // Remove trailing zeros but keep at least one decimal place
  let result = formatted.replace(/\.?0+$/, '');
  if (!result.includes('.')) {
    result = formatted.slice(0, formatted.indexOf('.') + 2);
  }
  return result;
}

/**
 * Convert an order type to wire format
 */
function orderTypeToWire(orderType: 'market' | 'limit', tif: 'Ioc' | 'Gtc' | 'Alo'): { limit: { tif: string } } {
  return { limit: { tif } };
}

export class HyperliquidClient {
  private api: AxiosInstance;
  private assetId: number | null = null;
  private assetDecimals: number = 4;
  private assetMaxLeverage: number = 20;
  private perpDexIndex: number | null = null;
  private indexInMeta: number | null = null;

  constructor(apiUrl: string = 'https://api.hyperliquid.xyz') {
    this.api = axios.create({
      baseURL: apiUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  /**
   * Initialize client by fetching market metadata
   * Supports both native perps and HIP-3 builder perps (xyz:GOLD, etc.)
   */
  async initialize(): Promise<void> {
    try {
      let meta: MetaResponse;

      if (ASSET_CONFIG.dex) {
        // For HIP-3 perps, first get perpDexs to find the dex index
        const perpDexsResponse = await this.api.post('/info', { type: 'perpDexs' });
        const perpDexs = perpDexsResponse.data as Array<{ name: string } | null>;
        const dexIndex = perpDexs.findIndex((d) => d && d.name === ASSET_CONFIG.dex);

        if (dexIndex === -1) {
          throw new Error(`Perp Dex ${ASSET_CONFIG.dex} not found on Hyperliquid`);
        }
        this.perpDexIndex = dexIndex;

        // Get meta for the specific dex
        meta = await this.getMeta(ASSET_CONFIG.dex);
      } else {
        // For native perps
        meta = await this.getMeta();
      }

      // Find the asset in meta
      // For HIP-3 perps, the asset name in meta includes the dex prefix (e.g., "xyz:GOLD")
      const searchName = ASSET_CONFIG.dex ? ASSET_CONFIG.fullName : ASSET_CONFIG.coin;
      const assetIndex = meta.universe.findIndex((a) => a.name === searchName);
      if (assetIndex === -1) {
        throw new Error(`${ASSET_CONFIG.fullName} market not found on Hyperliquid`);
      }

      const asset = meta.universe[assetIndex];
      this.indexInMeta = assetIndex;

      // Calculate asset ID
      if (ASSET_CONFIG.dex && this.perpDexIndex !== null) {
        // HIP-3 asset ID formula: 100000 + perp_dex_index * 10000 + index_in_meta
        this.assetId = 100000 + this.perpDexIndex * 10000 + assetIndex;
      } else {
        this.assetId = assetIndex;
      }

      this.assetDecimals = asset.szDecimals;
      this.assetMaxLeverage = asset.maxLeverage;

      console.log(
        `[Hyperliquid] Initialized ${ASSET_CONFIG.dex ? 'HIP-3' : 'native'} asset: ${ASSET_CONFIG.fullName}`,
        `dexIndex=${this.perpDexIndex}, indexInMeta=${this.indexInMeta}, assetId=${this.assetId},`,
        `decimals=${this.assetDecimals}, maxLeverage=${this.assetMaxLeverage}`
      );
    } catch (error) {
      console.error(`[Hyperliquid] Failed to initialize: ${error}`);
      throw error;
    }
  }

  private getAssetId(): number {
    if (this.assetId === null) {
      throw new Error('HyperliquidClient not initialized. Call initialize() first.');
    }
    return this.assetId;
  }

  /**
   * Fetch market metadata
   */
  async getMeta(dex?: string): Promise<MetaResponse> {
    const response = await this.api.post('/info', { type: 'meta', ...(dex && { dex }) });
    return response.data;
  }

  /**
   * Get current price for the configured trading asset
   */
  async getGoldPrice(): Promise<number> {
    const response = await this.api.post('/info', {
      type: 'allMids',
      ...(ASSET_CONFIG.dex && { dex: ASSET_CONFIG.dex }),
    });
    const mids = response.data as Record<string, string>;
    // For HIP-3 perps, the key is the full name (e.g., "xyz:GOLD")
    const priceKey = ASSET_CONFIG.dex ? ASSET_CONFIG.fullName : ASSET_CONFIG.coin;
    const price = mids[priceKey];

    if (!price) {
      throw new Error(`${ASSET_CONFIG.fullName} price not available`);
    }

    return parseFloat(price);
  }

  /**
   * Get user account state (balance, positions)
   * NOTE: Always query main perps account (no dex param) for balance.
   * HIP-3 perps use "dex abstraction" - USDC from main account is available for trading.
   */
  async getUserState(walletAddress: string): Promise<UserState> {
    // Query main perps account - DO NOT pass dex param for balance
    const response = await this.api.post('/info', {
      type: 'clearinghouseState',
      user: walletAddress.toLowerCase(),
    });
    return response.data;
  }

  /**
   * Get position for the configured trading asset
   */
  async getGoldPosition(walletAddress: string): Promise<AssetPosition | null> {
    const state = await this.getUserState(walletAddress);
    return state.assetPositions.find((p) => p.position.coin === ASSET_CONFIG.fullName) || null;
  }

  /**
   * Get open orders for the configured trading asset
   */
  async getOpenOrders(walletAddress: string): Promise<OpenOrder[]> {
    const payload: { type: string; user: string; dex?: string } = {
      type: 'openOrders',
      user: walletAddress.toLowerCase(),
    };
    if (ASSET_CONFIG.dex) {
      payload.dex = ASSET_CONFIG.dex;
    }
    const response = await this.api.post('/info', payload);
    const orders = response.data as OpenOrder[];
    return orders.filter((o) => o.coin === ASSET_CONFIG.fullName);
  }

  /**
   * Send an L1 action to the exchange
   */
  private async sendAction(
    agentPrivateKey: string,
    walletAddress: string,
    action: Record<string, unknown>,
    nonce?: number
  ): Promise<{ status: string; response: unknown }> {
    const wallet = new Wallet(agentPrivateKey);
    const timestamp = nonce || Date.now();

    // Sign the action
    const signature = await signL1Action(wallet, action, null, timestamp);

    // Send to exchange
    const response = await this.api.post('/exchange', {
      action,
      nonce: timestamp,
      signature,
      vaultAddress: walletAddress.toLowerCase(), // Trading on behalf of this address
    });

    console.log(`[Hyperliquid] Action response:`, JSON.stringify(response.data));
    return response.data;
  }

  /**
   * Update leverage for the trading asset
   */
  async updateLeverage(
    agentPrivateKey: string,
    walletAddress: string,
    leverage: number,
    isCross: boolean = false
  ): Promise<void> {
    const action = {
      type: 'updateLeverage',
      asset: this.getAssetId(),
      isCross,
      leverage,
    };

    try {
      await this.sendAction(agentPrivateKey, walletAddress, action);
      console.log(`[Hyperliquid] Leverage updated to ${leverage}x`);
    } catch (e) {
      console.log(`[Hyperliquid] Leverage update may have failed:`, e);
      // Non-fatal, continue with order
    }
  }

  /**
   * Place an order using direct L1 action signing
   */
  async placeOrder(
    agentPrivateKey: string,
    walletAddress: string,
    params: PlaceOrderParams
  ): Promise<OrderResult> {
    // Validate leverage
    if (params.leverage < 1 || params.leverage > this.assetMaxLeverage) {
      throw new Error(`Leverage must be between 1 and ${this.assetMaxLeverage}`);
    }

    // Get current price for size calculation and market order pricing
    const midPrice = await this.getGoldPrice();

    // Calculate size in asset units
    const sizeInAsset = params.sizeUsd / midPrice;
    const roundedSize = this.roundToDecimals(sizeInAsset, this.assetDecimals);

    if (roundedSize <= 0) {
      throw new Error('Order size too small');
    }

    // Determine order price
    let orderPrice: number;
    let tif: 'Ioc' | 'Gtc';

    if (params.orderType === 'market') {
      // Market order: use slippage-adjusted price with IOC
      const slippageMultiplier = params.side === 'long' ? 1 + SLIPPAGE_BPS / 10000 : 1 - SLIPPAGE_BPS / 10000;
      orderPrice = midPrice * slippageMultiplier;
      tif = 'Ioc';
    } else {
      if (!params.limitPrice) {
        throw new Error('Limit price required for limit orders');
      }
      orderPrice = params.limitPrice;
      tif = 'Gtc';
    }

    // Update leverage first (isolated for HIP-3)
    await this.updateLeverage(agentPrivateKey, walletAddress, params.leverage, false);

    // Build the order action
    // IMPORTANT: Field order matters for msgpack serialization
    const orderWire = {
      a: this.getAssetId(), // asset
      b: params.side === 'long', // is_buy
      p: floatToWire(orderPrice), // limit_px
      s: floatToWire(roundedSize), // sz
      r: false, // reduce_only
      t: orderTypeToWire(params.orderType, tif), // order_type
      c: undefined, // cloid (optional client order id)
    };

    const action = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
    };

    try {
      const result = await this.sendAction(agentPrivateKey, walletAddress, action);

      if (result.status === 'ok') {
        return { status: 'ok', response: result.response as any };
      } else {
        const errorMsg = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        return { status: 'err', error: errorMsg || 'Order failed' };
      }
    } catch (e: any) {
      console.error(`[Hyperliquid] Order error:`, e);
      const errorMsg = e.response?.data?.response || e.message || 'Unknown error';
      return { status: 'err', error: errorMsg };
    }
  }

  /**
   * Close entire position at market
   */
  async closePosition(agentPrivateKey: string, walletAddress: string): Promise<OrderResult> {
    const position = await this.getGoldPosition(walletAddress);

    if (!position || parseFloat(position.position.szi) === 0) {
      throw new Error(`No ${ASSET_CONFIG.fullName} position to close`);
    }

    const size = Math.abs(parseFloat(position.position.szi));
    const isLong = parseFloat(position.position.szi) > 0;
    const midPrice = await this.getGoldPrice();

    // Close in opposite direction with slippage
    const slippageMultiplier = isLong ? 1 - SLIPPAGE_BPS / 10000 : 1 + SLIPPAGE_BPS / 10000;
    const closePrice = midPrice * slippageMultiplier;

    const orderWire = {
      a: this.getAssetId(),
      b: !isLong, // Opposite direction
      p: floatToWire(closePrice),
      s: floatToWire(size),
      r: true, // reduce_only
      t: { limit: { tif: 'Ioc' } },
      c: undefined,
    };

    const action = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
    };

    try {
      const result = await this.sendAction(agentPrivateKey, walletAddress, action);

      if (result.status === 'ok') {
        return { status: 'ok', response: result.response as any };
      } else {
        const errorMsg = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        return { status: 'err', error: errorMsg || 'Close failed' };
      }
    } catch (e: any) {
      const errorMsg = e.response?.data?.response || e.message || 'Unknown error';
      return { status: 'err', error: errorMsg };
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(agentPrivateKey: string, walletAddress: string, orderId: number): Promise<OrderResult> {
    const action = {
      type: 'cancel',
      cancels: [
        {
          a: this.getAssetId(),
          o: orderId,
        },
      ],
    };

    try {
      const result = await this.sendAction(agentPrivateKey, walletAddress, action);

      if (result.status === 'ok') {
        return { status: 'ok', response: result.response as any };
      } else {
        const errorMsg = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
        return { status: 'err', error: errorMsg || 'Cancel failed' };
      }
    } catch (e: any) {
      const errorMsg = e.response?.data?.response || e.message || 'Unknown error';
      return { status: 'err', error: errorMsg };
    }
  }

  /**
   * Cancel all orders for the trading asset
   */
  async cancelAllOrders(agentPrivateKey: string, walletAddress: string): Promise<OrderResult[]> {
    const orders = await this.getOpenOrders(walletAddress);
    const results: OrderResult[] = [];

    for (const order of orders) {
      try {
        const result = await this.cancelOrder(agentPrivateKey, walletAddress, order.oid);
        results.push(result);
      } catch (e) {
        results.push({ status: 'err', error: String(e) });
      }
    }

    return results;
  }

  private roundToDecimals(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;
  }
}

// Singleton instance
let clientInstance: HyperliquidClient | null = null;

export async function getHyperliquidClient(): Promise<HyperliquidClient> {
  if (!clientInstance) {
    clientInstance = new HyperliquidClient();
    await clientInstance.initialize();
  }
  return clientInstance;
}
