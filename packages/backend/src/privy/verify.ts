import { PrivyClient } from '@privy-io/server-auth';
import { z } from 'zod';

let privyClient: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    const appId = process.env.PRIVY_APP_ID;
    const appSecret = process.env.PRIVY_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required');
    }

    privyClient = new PrivyClient(appId, appSecret);
  }

  return privyClient;
}

/**
 * Verify a Privy auth token and extract user info
 */
export interface PrivyUserInfo {
  privyUserId: string;
  walletAddress: string;
}

export async function verifyPrivyToken(token: string): Promise<PrivyUserInfo> {
  const client = getPrivyClient();

  try {
    const claims = await client.verifyAuthToken(token);
    const userId = claims.userId;

    // Get user's wallet address
    const user = await client.getUser(userId);

    // Find embedded wallet
    const embeddedWallet = user.linkedAccounts.find(
      (account) => account.type === 'wallet' && account.walletClientType === 'privy'
    );

    if (!embeddedWallet || !('address' in embeddedWallet)) {
      throw new Error('No embedded wallet found');
    }

    return {
      privyUserId: userId,
      walletAddress: embeddedWallet.address,
    };
  } catch (error) {
    console.error('[Privy] Token verification failed:', error);
    throw new Error('Invalid authentication token');
  }
}

/**
 * Schema for Mini App registration request
 */
export const RegistrationRequestSchema = z.object({
  privyToken: z.string().min(1),
  telegramUserId: z.string().regex(/^\d+$/),
  agentAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  agentPrivateKey: z.string().min(64).max(66), // With or without 0x prefix
});

export type RegistrationRequest = z.infer<typeof RegistrationRequestSchema>;

/**
 * Validate Telegram Web App init data
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(initData: string, botToken: string): boolean {
  try {
    const crypto = require('crypto');
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    // Sort and join params
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // Calculate HMAC
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return hash === calculatedHash;
  } catch (error) {
    console.error('[Telegram] Init data validation failed:', error);
    return false;
  }
}

/**
 * Extract Telegram user ID from init data
 */
export function extractTelegramUserId(initData: string): string | null {
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');

    if (!userJson) return null;

    const user = JSON.parse(userJson);
    return user.id?.toString() || null;
  } catch {
    return null;
  }
}

