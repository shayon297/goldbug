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

const GOLD_COIN = 'GOLD';
const SLIPPAGE_BPS = 100; // 1% slippage for market orders

export class HyperliquidClient {
  private api: AxiosInstance;
  private goldAssetIndex: number | null = null;
  private goldDecimals: number = 2;
  private goldMaxLeverage: number = 20;

  constructor(apiUrl: string = 'https://api.hyperliquid.xyz') {
    this.api = axios.create({
      baseURL: apiUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  /**
   * Initialize client by fetching GOLD market metadata
   */
  async initialize(): Promise<void> {
    const meta = await this.getMeta();
    const goldIndex = meta.universe.findIndex((a) => a.name === GOLD_COIN);

    if (goldIndex === -1) {
      throw new Error('GOLD market not found on Hyperliquid');
    }

    this.goldAssetIndex = goldIndex;
    this.goldDecimals = meta.universe[goldIndex].szDecimals;
    this.goldMaxLeverage = meta.universe[goldIndex].maxLeverage;

    console.log(
      `[Hyperliquid] Initialized: GOLD index=${goldIndex}, decimals=${this.goldDecimals}, maxLeverage=${this.goldMaxLeverage}`
    );
  }

  private getAssetIndex(): number {
    if (this.goldAssetIndex === null) {
      throw new Error('HyperliquidClient not initialized. Call initialize() first.');
    }
    return this.goldAssetIndex;
  }

  /**
   * Fetch market metadata
   */
  async getMeta(): Promise<MetaResponse> {
    const response = await this.api.post('/info', { type: 'meta' });
    return response.data;
  }

  /**
   * Get current GOLD mid price
   */
  async getGoldPrice(): Promise<number> {
    const response = await this.api.post('/info', {
      type: 'allMids',
    });
    const mids = response.data as Record<string, string>;
    const goldPrice = mids[GOLD_COIN];

    if (!goldPrice) {
      throw new Error('GOLD price not available');
    }

    return parseFloat(goldPrice);
  }

  /**
   * Get user account state (balance, positions)
   */
  async getUserState(walletAddress: string): Promise<UserState> {
    const response = await this.api.post('/info', {
      type: 'clearinghouseState',
      user: walletAddress.toLowerCase(),
    });
    return response.data;
  }

  /**
   * Get GOLD position for a user
   */
  async getGoldPosition(walletAddress: string): Promise<AssetPosition | null> {
    const state = await this.getUserState(walletAddress);
    return state.assetPositions.find((p) => p.position.coin === GOLD_COIN) || null;
  }

  /**
   * Get open orders for GOLD
   */
  async getOpenOrders(walletAddress: string): Promise<OpenOrder[]> {
    const response = await this.api.post('/info', {
      type: 'openOrders',
      user: walletAddress.toLowerCase(),
    });
    const orders = response.data as OpenOrder[];
    return orders.filter((o) => o.coin === GOLD_COIN);
  }

  /**
   * Update leverage for GOLD
   */
  async updateLeverage(agentWallet: Wallet, leverage: number, isCross: boolean = true): Promise<void> {
    if (leverage < 1 || leverage > this.goldMaxLeverage) {
      throw new Error(`Leverage must be between 1 and ${this.goldMaxLeverage}`);
    }

    const action = {
      type: 'updateLeverage',
      asset: this.getAssetIndex(),
      isCross,
      leverage,
    };

    await this.sendAction(agentWallet, action);
  }

  /**
   * Place an order for GOLD
   */
  async placeOrder(agentWallet: Wallet, params: PlaceOrderParams): Promise<OrderResult> {
    // Validate leverage
    if (params.leverage < 1 || params.leverage > 20) {
      throw new Error('Leverage must be between 1 and 20');
    }

    // Get current price for size calculation and market order pricing
    const midPrice = await this.getGoldPrice();

    // Calculate size in GOLD units
    const sizeInGold = params.sizeUsd / midPrice;
    const roundedSize = this.roundToDecimals(sizeInGold, this.goldDecimals);

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
          a: this.getAssetIndex(),
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
   * Close entire GOLD position at market
   */
  async closePosition(agentWallet: Wallet, walletAddress: string): Promise<OrderResult> {
    const position = await this.getGoldPosition(walletAddress);

    if (!position || parseFloat(position.position.szi) === 0) {
      throw new Error('No GOLD position to close');
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
          a: this.getAssetIndex(),
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
          a: this.getAssetIndex(),
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

