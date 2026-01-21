import axios, { AxiosInstance } from 'axios';
import { Hyperliquid } from 'hyperliquid';
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

export class HyperliquidClient {
  private api: AxiosInstance;
  private assetId: number | null = null;
  private assetDecimals: number = 4;
  private assetMaxLeverage: number = 20;
  private perpDexIndex: number | null = null;
  private indexInMeta: number | null = null;
  private sdkCache: Map<string, Hyperliquid> = new Map();

  constructor(apiUrl: string = 'https://api.hyperliquid.xyz') {
    this.api = axios.create({
      baseURL: apiUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  /**
   * Get or create an SDK instance for the given private key
   */
  private async getSDK(privateKey: string, walletAddress: string): Promise<Hyperliquid> {
    const cacheKey = privateKey.slice(0, 10); // Use partial key for cache
    
    if (this.sdkCache.has(cacheKey)) {
      return this.sdkCache.get(cacheKey)!;
    }

    const sdk = new Hyperliquid({
      privateKey,
      testnet: false,
      walletAddress, // The main wallet address this agent trades for
    });

    await sdk.connect();
    this.sdkCache.set(cacheKey, sdk);
    return sdk;
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
   * Place an order using the Hyperliquid SDK
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

    // Get SDK instance
    const sdk = await this.getSDK(agentPrivateKey, walletAddress);

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
    if (params.orderType === 'market') {
      // Market order: use slippage-adjusted price
      const slippageMultiplier = params.side === 'long' ? 1 + SLIPPAGE_BPS / 10000 : 1 - SLIPPAGE_BPS / 10000;
      orderPrice = midPrice * slippageMultiplier;
    } else {
      if (!params.limitPrice) {
        throw new Error('Limit price required for limit orders');
      }
      orderPrice = params.limitPrice;
    }

    try {
      // Update leverage first
      await sdk.exchange.updateLeverage(ASSET_CONFIG.fullName, 'isolated', params.leverage);
    } catch (e) {
      console.log('[Hyperliquid] Leverage update may have failed, continuing:', e);
    }

    // Place the order using SDK
    const result = await sdk.exchange.placeOrder({
      coin: ASSET_CONFIG.fullName,
      is_buy: params.side === 'long',
      sz: roundedSize,
      limit_px: orderPrice,
      order_type: params.orderType === 'market' ? { limit: { tif: 'Ioc' } } : { limit: { tif: 'Gtc' } },
      reduce_only: false,
    });

    console.log('[Hyperliquid] Order result:', JSON.stringify(result));

    // Convert SDK response to our format
    if (result.status === 'ok') {
      return { status: 'ok', response: result.response as any };
    } else {
      return { status: 'err', error: String(result.response) || 'Order failed' };
    }
  }

  /**
   * Close entire position at market
   */
  async closePosition(
    agentPrivateKey: string,
    walletAddress: string
  ): Promise<OrderResult> {
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

    // Get SDK instance
    const sdk = await this.getSDK(agentPrivateKey, walletAddress);

    const result = await sdk.exchange.placeOrder({
      coin: ASSET_CONFIG.fullName,
      is_buy: !isLong,
      sz: size,
      limit_px: closePrice,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: true,
    });

    if (result.status === 'ok') {
      return { status: 'ok', response: result.response as any };
    } else {
      return { status: 'err', error: String(result.response) || 'Close failed' };
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(
    agentPrivateKey: string,
    walletAddress: string,
    orderId: number
  ): Promise<OrderResult> {
    const sdk = await this.getSDK(agentPrivateKey, walletAddress);

    const result = await sdk.exchange.cancelOrder({
      coin: ASSET_CONFIG.fullName,
      o: orderId,
    });

    if (result.status === 'ok') {
      return { status: 'ok', response: result.response as any };
    } else {
      return { status: 'err', error: String(result.response) || 'Cancel failed' };
    }
  }

  /**
   * Cancel all orders for the trading asset
   */
  async cancelAllOrders(
    agentPrivateKey: string,
    walletAddress: string
  ): Promise<OrderResult[]> {
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
