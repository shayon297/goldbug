import axios, { AxiosInstance } from 'axios';
import { Wallet, ethers } from 'ethers';
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
    if (ASSET_CONFIG.dex) {
      // HIP-3 builder perp - query dex-specific meta
      await this.initializeHIP3Asset();
    } else {
      // Native perp - query main meta
      await this.initializeNativeAsset();
    }
  }

  /**
   * Initialize HIP-3 builder perp (e.g., xyz:GOLD)
   */
  private async initializeHIP3Asset(): Promise<void> {
    // Get perp dex index from perpDexs response
    const dexsResponse = await this.api.post('/info', { type: 'perpDexs' });
    const dexs = dexsResponse.data as (null | { name: string })[];
    
    const dexIndex = dexs.findIndex((d) => d && d.name === ASSET_CONFIG.dex);
    if (dexIndex === -1) {
      throw new Error(`DEX "${ASSET_CONFIG.dex}" not found on Hyperliquid`);
    }
    this.perpDexIndex = dexIndex;

    // Get meta for the specific dex
    const meta = await this.getMeta();
    const assetIndex = meta.universe.findIndex((a) => a.name === ASSET_CONFIG.fullName);

    if (assetIndex === -1) {
      throw new Error(`${ASSET_CONFIG.fullName} not found in ${ASSET_CONFIG.dex} dex`);
    }

    this.indexInMeta = assetIndex;
    this.assetDecimals = meta.universe[assetIndex].szDecimals;
    this.assetMaxLeverage = meta.universe[assetIndex].maxLeverage;
    
    // Calculate asset ID for HIP-3 perps: 100000 + perp_dex_index * 10000 + index_in_meta
    this.assetId = 100000 + this.perpDexIndex * 10000 + this.indexInMeta;

    console.log(
      `[Hyperliquid] Initialized HIP-3 asset: ${ASSET_CONFIG.fullName} ` +
      `dexIndex=${this.perpDexIndex}, indexInMeta=${this.indexInMeta}, ` +
      `assetId=${this.assetId}, decimals=${this.assetDecimals}, maxLeverage=${this.assetMaxLeverage}`
    );
  }

  /**
   * Initialize native perp (BTC, ETH, etc.)
   */
  private async initializeNativeAsset(): Promise<void> {
    const response = await this.api.post('/info', { type: 'meta' });
    const meta = response.data as MetaResponse;
    const assetIndex = meta.universe.findIndex((a) => a.name === ASSET_CONFIG.coin);

    if (assetIndex === -1) {
      throw new Error(`${ASSET_CONFIG.coin} not found on Hyperliquid`);
    }

    this.assetId = assetIndex;
    this.indexInMeta = assetIndex;
    this.assetDecimals = meta.universe[assetIndex].szDecimals;
    this.assetMaxLeverage = meta.universe[assetIndex].maxLeverage;

    console.log(
      `[Hyperliquid] Initialized native asset: ${ASSET_CONFIG.coin} ` +
      `assetId=${this.assetId}, decimals=${this.assetDecimals}, maxLeverage=${this.assetMaxLeverage}`
    );
  }

  private getAssetId(): number {
    if (this.assetId === null) {
      throw new Error('HyperliquidClient not initialized. Call initialize() first.');
    }
    return this.assetId;
  }

  /**
   * Fetch market metadata
   * For HIP-3 perps, queries the specific dex
   */
  async getMeta(): Promise<MetaResponse> {
    const payload: { type: string; dex?: string } = { type: 'meta' };
    if (ASSET_CONFIG.dex) {
      payload.dex = ASSET_CONFIG.dex;
    }
    const response = await this.api.post('/info', payload);
    return response.data;
  }

  /**
   * Get current asset mid price
   */
  async getGoldPrice(): Promise<number> {
    const payload: { type: string; dex?: string } = { type: 'allMids' };
    if (ASSET_CONFIG.dex) {
      payload.dex = ASSET_CONFIG.dex;
    }
    const response = await this.api.post('/info', payload);
    const mids = response.data as Record<string, string>;
    const price = mids[ASSET_CONFIG.fullName];

    if (!price) {
      throw new Error(`${ASSET_CONFIG.fullName} price not available`);
    }

    return parseFloat(price);
  }

  /**
   * Get user account state (balance, positions)
   * For HIP-3 perps, we may need to query dex-specific state
   */
  async getUserState(walletAddress: string): Promise<UserState> {
    const payload: { type: string; user: string; dex?: string } = {
      type: 'clearinghouseState',
      user: walletAddress.toLowerCase(),
    };
    if (ASSET_CONFIG.dex) {
      payload.dex = ASSET_CONFIG.dex;
    }
    const response = await this.api.post('/info', payload);
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
   * Update leverage for the configured asset
   * Note: HIP-3 perps are isolated-only, so isCross is forced to false
   */
  async updateLeverage(agentWallet: Wallet, leverage: number, isCross: boolean = false): Promise<void> {
    if (leverage < 1 || leverage > this.assetMaxLeverage) {
      throw new Error(`Leverage must be between 1 and ${this.assetMaxLeverage}`);
    }

    // HIP-3 perps require isolated margin mode
    const useIsolated = ASSET_CONFIG.dex ? false : isCross;

    const action = {
      type: 'updateLeverage',
      asset: this.getAssetId(),
      isCross: useIsolated,
      leverage,
    };

    await this.sendAction(agentWallet, action);
  }

  /**
   * Place an order for the configured trading asset
   */
  async placeOrder(agentWallet: Wallet, params: PlaceOrderParams): Promise<OrderResult> {
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

    // Update leverage first
    await this.updateLeverage(agentWallet, params.leverage);

    // Place the order
    const action = {
      type: 'order',
      orders: [
        {
          a: this.getAssetId(),
          b: params.side === 'long',
          p: this.formatPrice(orderPrice),
          s: roundedSize.toString(),
          r: false, // Not reduce-only
          t: params.orderType === 'market' ? { limit: { tif: 'Ioc' } } : { limit: { tif: 'Gtc' } },
        },
      ],
      grouping: 'na',
    };

    return this.sendAction(agentWallet, action);
  }

  /**
   * Close entire position at market
   */
  async closePosition(agentWallet: Wallet, walletAddress: string): Promise<OrderResult> {
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

    const action = {
      type: 'order',
      orders: [
        {
          a: this.getAssetId(),
          b: !isLong, // Opposite direction to close
          p: this.formatPrice(closePrice),
          s: size.toString(),
          r: true, // Reduce-only
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    };

    return this.sendAction(agentWallet, action);
  }

  /**
   * Cancel a specific order
   */
  async cancelOrder(agentWallet: Wallet, orderId: number): Promise<OrderResult> {
    const action = {
      type: 'cancel',
      cancels: [
        {
          a: this.getAssetId(),
          o: orderId,
        },
      ],
    };

    return this.sendAction(agentWallet, action);
  }

  /**
   * Cancel all GOLD orders
   */
  async cancelAllOrders(agentWallet: Wallet, walletAddress: string): Promise<OrderResult[]> {
    const orders = await this.getOpenOrders(walletAddress);
    const results: OrderResult[] = [];

    for (const order of orders) {
      const result = await this.cancelOrder(agentWallet, order.oid);
      results.push(result);
    }

    return results;
  }

  /**
   * Send a signed action to Hyperliquid exchange
   */
  private async sendAction(agentWallet: Wallet, action: Record<string, unknown>): Promise<OrderResult> {
    const nonce = Date.now();
    const signature = await this.signL1Action(agentWallet, action, nonce);

    const response = await this.api.post('/exchange', {
      action,
      nonce,
      signature,
      vaultAddress: null,
    });

    return response.data;
  }

  /**
   * Sign an L1 action using the agent wallet
   * Based on Hyperliquid's signing requirements
   */
  private async signL1Action(
    wallet: Wallet,
    action: Record<string, unknown>,
    nonce: number
  ): Promise<{ r: string; s: string; v: number }> {
    // Hyperliquid uses a specific phantom agent signing scheme
    const connectionId = ethers.keccak256(ethers.toUtf8Bytes('hyperliquid'));

    // Create the action hash
    const actionHash = this.hashAction(action, nonce);

    // Sign with EIP-191 personal sign
    const message = ethers.getBytes(actionHash);
    const signature = await wallet.signMessage(message);

    // Parse signature
    const sig = ethers.Signature.from(signature);

    return {
      r: sig.r,
      s: sig.s,
      v: sig.v,
    };
  }

  /**
   * Hash action for signing (simplified - real implementation needs msgpack)
   */
  private hashAction(action: Record<string, unknown>, nonce: number): string {
    // In production, this should use msgpack encoding as per Hyperliquid SDK
    // For now, using a simplified JSON-based hash
    const payload = JSON.stringify({ action, nonce });
    return ethers.keccak256(ethers.toUtf8Bytes(payload));
  }

  private roundToDecimals(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.floor(value * factor) / factor;
  }

  private formatPrice(price: number): string {
    // Hyperliquid prices need specific formatting
    return price.toFixed(1);
  }
}

// Singleton instance
let clientInstance: HyperliquidClient | null = null;

export async function getHyperliquidClient(): Promise<HyperliquidClient> {
  if (!clientInstance) {
    const apiUrl = process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz';
    clientInstance = new HyperliquidClient(apiUrl);
    await clientInstance.initialize();
  }
  return clientInstance;
}

