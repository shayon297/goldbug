import axios, { AxiosInstance } from 'axios';
import type {
  MetaResponse,
  UserState,
  OpenOrder,
  UserFill,
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
  private signer: AxiosInstance | null = null;
  private signerApiKey: string | undefined;
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

    const signerUrl = process.env.SIGNER_URL;
    this.signerApiKey = process.env.SIGNER_API_KEY;
    if (signerUrl) {
      this.signer = axios.create({
        baseURL: signerUrl,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });
    }
  }

  private async signerRequest<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.signer) {
      throw new Error('SIGNER_URL is not configured');
    }

    const headers: Record<string, string> = {};
    if (this.signerApiKey) {
      headers['X-Signer-Api-Key'] = this.signerApiKey;
    }

    const response = await this.signer.post(path, payload, { headers });
    return response.data as T;
  }

  /**
   * Make an info API call with retry logic for rate limiting
   */
  private async infoRequest<T>(payload: Record<string, unknown>): Promise<T> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.api.post('/info', payload);
        return response.data as T;
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number } };
        if (axiosError.response?.status === 429) {
          // Rate limited - exponential backoff
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.log(`[Hyperliquid] Rate limited on info request, retrying in ${Math.round(delay)}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          lastError = error instanceof Error ? error : new Error('Rate limited');
        } else {
          throw error;
        }
      }
    }

    throw lastError || new Error('Max retries exceeded due to rate limiting');
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
        const perpDexs = await this.infoRequest<Array<{ name: string } | null>>({ type: 'perpDexs' });
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
    return this.infoRequest<MetaResponse>({ type: 'meta', ...(dex && { dex }) });
  }

  /**
   * Get approved maximum builder fee rate for a user + builder
   */
  async getMaxBuilderFee(userAddress: string, builderAddress: string): Promise<string> {
    const response = await this.infoRequest<string | number>({
      type: 'maxBuilderFee',
      user: userAddress,
      builder: builderAddress.toLowerCase(),
    });

    return typeof response === 'number' ? response.toString() : response;
  }

  /**
   * Check if builder fee is approved for a user
   */
  async isBuilderFeeApproved(userAddress: string, builderAddress: string): Promise<boolean> {
    try {
      const maxFeeRate = await this.getMaxBuilderFee(userAddress, builderAddress);
      const numeric = parseFloat(maxFeeRate.replace('%', ''));
      return !Number.isNaN(numeric) && numeric > 0;
    } catch (error) {
      console.error('[Hyperliquid] Failed to check builder fee approval:', error);
      return false;
    }
  }

  /**
   * Get current price for the configured trading asset
   */
  async getGoldPrice(): Promise<number> {
    const mids = await this.infoRequest<Record<string, string>>({
      type: 'allMids',
      ...(ASSET_CONFIG.dex && { dex: ASSET_CONFIG.dex }),
    });
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
    return this.infoRequest<UserState>({
      type: 'clearinghouseState',
      user: walletAddress.toLowerCase(),
    });
  }

  /**
   * Get user state for positions (HIP-3 perps require dex param for positions)
   */
  async getUserStateForPositions(walletAddress: string): Promise<UserState> {
    if (ASSET_CONFIG.dex) {
      return this.infoRequest<UserState>({
        type: 'clearinghouseState',
        user: walletAddress.toLowerCase(),
        dex: ASSET_CONFIG.dex,
      });
    }

    return this.getUserState(walletAddress);
  }

  /**
   * Get position for the configured trading asset
   */
  async getGoldPosition(walletAddress: string): Promise<AssetPosition | null> {
    const state = await this.getUserStateForPositions(walletAddress);
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
    const orders = await this.infoRequest<OpenOrder[]>(payload);
    return orders.filter((o) => o.coin === ASSET_CONFIG.fullName);
  }

  /**
   * Get recent fills for the configured trading asset
   */
  async getUserFills(walletAddress: string): Promise<UserFill[]> {
    const fills = await this.infoRequest<UserFill[]>({
      type: 'userFills',
      user: walletAddress.toLowerCase(),
      aggregateByTime: true,
    });
    return fills.filter((fill) => fill.coin === ASSET_CONFIG.fullName);
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
    try {
      await this.signerRequest('/l1/update_leverage', {
        agent_private_key: agentPrivateKey,
        wallet_address: walletAddress,
        coin: ASSET_CONFIG.fullName,
        leverage,
        is_cross: isCross,
      });
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

    // Determine order price for limit orders
    let orderPrice: number | undefined;
    let tif: 'Ioc' | 'Gtc' | undefined;

    if (params.orderType === 'market') {
      // Market orders use SDK market_open with slippage
      orderPrice = undefined;
      tif = undefined;
    } else {
      if (!params.limitPrice) {
        throw new Error('Limit price required for limit orders');
      }
      orderPrice = params.limitPrice;
      tif = 'Gtc';
    }

    // Enable dex abstraction for HIP-3 assets (required to use main perps balance)
    if (ASSET_CONFIG.dex) {
      try {
        await this.signerRequest('/l1/enable_dex', {
          agent_private_key: agentPrivateKey,
          wallet_address: walletAddress,
        });
      } catch (e) {
        console.log('[Hyperliquid] Dex abstraction enable may have failed:', e);
      }
    }

    // Update leverage first (isolated for HIP-3)
    await this.updateLeverage(agentPrivateKey, walletAddress, params.leverage, false);

    try {
      const result =
        params.orderType === 'market'
          ? await this.signerRequest<OrderResult>('/l1/market_open', {
              agent_private_key: agentPrivateKey,
              wallet_address: walletAddress,
              coin: ASSET_CONFIG.fullName,
              is_buy: params.side === 'long',
              size: roundedSize,
              slippage: SLIPPAGE_BPS / 10000,
            })
          : await this.signerRequest<OrderResult>('/l1/order', {
              agent_private_key: agentPrivateKey,
              wallet_address: walletAddress,
              coin: ASSET_CONFIG.fullName,
              is_buy: params.side === 'long',
              size: roundedSize,
              limit_px: orderPrice,
              tif,
              reduce_only: false,
            });

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
    return this.closePartialPosition(agentPrivateKey, walletAddress, 1.0);
  }

  /**
   * Close a fraction of the position at market
   * @param fraction - 1.0 for full close, 0.5 for half, etc.
   */
  async closePartialPosition(agentPrivateKey: string, walletAddress: string, fraction: number): Promise<OrderResult> {
    const position = await this.getGoldPosition(walletAddress);

    if (!position || parseFloat(position.position.szi) === 0) {
      throw new Error(`No ${ASSET_CONFIG.fullName} position to close`);
    }

    const fullSize = Math.abs(parseFloat(position.position.szi));
    const closeSize = this.roundToDecimals(fullSize * fraction, this.assetDecimals);

    if (closeSize <= 0) {
      throw new Error('Close size too small');
    }

    try {
      const result = await this.signerRequest<OrderResult>('/l1/market_close', {
        agent_private_key: agentPrivateKey,
        wallet_address: walletAddress,
        coin: ASSET_CONFIG.fullName,
        size: closeSize,
        slippage: SLIPPAGE_BPS / 10000,
      });

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
    try {
      const result = await this.signerRequest<OrderResult>('/l1/cancel', {
        agent_private_key: agentPrivateKey,
        wallet_address: walletAddress,
        coin: ASSET_CONFIG.fullName,
        oid: orderId,
      });

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
