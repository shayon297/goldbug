import { PrismaClient } from '@prisma/client';
import { ethers } from 'ethers';
import { encryptPrivateKey, decryptPrivateKey } from './crypto.js';

export const prisma = new PrismaClient();

export { encryptPrivateKey, decryptPrivateKey };

export interface CreateUserInput {
  telegramId: bigint;
  privyUserId: string;
  walletAddress: string;
  agentAddress: string;
  agentPrivateKey: string; // Will be encrypted before storage
}

export interface UserWithDecryptedKey {
  telegramId: bigint;
  privyUserId: string;
  walletAddress: string;
  agentAddress: string;
  agentPrivateKey: string;
  defaultLeverage: number;
  defaultSizeUsd: number;
  points: number;
}

/**
 * Create or update a user with encrypted agent key
 * Uses upsert to handle re-registration (e.g., when re-authorizing agent)
 */
export async function createUser(input: CreateUserInput) {
  const encryptedKey = encryptPrivateKey(input.agentPrivateKey);

  return prisma.user.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      privyUserId: input.privyUserId,
      walletAddress: input.walletAddress.toLowerCase(),
      agentAddress: input.agentAddress.toLowerCase(),
      agentKeyEncrypted: encryptedKey,
    },
    update: {
      privyUserId: input.privyUserId,
      walletAddress: input.walletAddress.toLowerCase(),
      agentAddress: input.agentAddress.toLowerCase(),
      agentKeyEncrypted: encryptedKey,
    },
  });
}

/**
 * Get user by Telegram ID with decrypted agent key
 * Validates that the decrypted key matches the stored address
 */
export async function getUserByTelegramId(telegramId: bigint): Promise<UserWithDecryptedKey | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
  });

  if (!user) return null;

  // Decrypt the agent private key
  const decryptedKey = decryptPrivateKey(user.agentKeyEncrypted);
  
  // Ensure the key has 0x prefix for ethers
  const keyWithPrefix = decryptedKey.startsWith('0x') ? decryptedKey : '0x' + decryptedKey;
  
  // Validate that the decrypted key matches the stored agent address
  const derivedAddress = ethers.computeAddress(keyWithPrefix).toLowerCase();
  if (derivedAddress !== user.agentAddress.toLowerCase()) {
    console.error(`[DB] Key mismatch for user ${telegramId}: stored=${user.agentAddress}, derived=${derivedAddress}`);
    // Return null to force re-registration - the stored data is corrupted
    return null;
  }

  return {
    telegramId: user.telegramId,
    privyUserId: user.privyUserId,
    walletAddress: user.walletAddress,
    agentAddress: user.agentAddress,
    agentPrivateKey: keyWithPrefix, // Always return with 0x prefix
    defaultLeverage: user.defaultLeverage,
    defaultSizeUsd: user.defaultSizeUsd,
    points: user.points,
  };
}

/**
 * Check if user exists
 */
export async function userExists(telegramId: bigint): Promise<boolean> {
  const count = await prisma.user.count({
    where: { telegramId },
  });
  return count > 0;
}

/**
 * Update user preferences
 */
export async function updateUserPreferences(
  telegramId: bigint,
  preferences: { defaultLeverage?: number; defaultSizeUsd?: number }
) {
  return prisma.user.update({
    where: { telegramId },
    data: preferences,
  });
}

/**
 * Points system for rewards
 */

// Points awarded for different actions
export const POINTS_CONFIG = {
  SHARE_TRADE: 10,      // Sharing a trade receipt
  REFERRAL_SIGNUP: 50,  // When someone you referred signs up
  REFERRAL_TRADE: 5,    // When someone you referred makes a trade (future)
} as const;

/**
 * Add points to a user's account
 * Returns the new total points
 */
export async function addPoints(telegramId: bigint, points: number): Promise<number> {
  const user = await prisma.user.update({
    where: { telegramId },
    data: {
      points: { increment: points },
    },
    select: { points: true },
  });
  return user.points;
}

/**
 * Get user's current points
 */
export async function getPoints(telegramId: bigint): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { points: true },
  });
  return user?.points ?? 0;
}

export async function getAllUsers(): Promise<Array<{ telegramId: bigint; walletAddress: string }>> {
  return prisma.user.findMany({
    select: {
      telegramId: true,
      walletAddress: true,
    },
  });
}

/**
 * Session management for order flow state
 */
export interface OrderContext {
  side?: 'long' | 'short';
  sizeUsd?: number;
  leverage?: number;
  orderType?: 'market' | 'limit';
  limitPrice?: number;
  step: 'idle' | 'select_side' | 'select_size' | 'select_leverage' | 'select_type' | 'confirm';
  // Pending order for auto-retry after authorization
  pendingOrder?: {
    side: 'long' | 'short';
    sizeUsd: number;
    leverage: number;
    orderType: 'market' | 'limit';
    limitPrice?: number;
  };
}

export async function getOrCreateSession(telegramId: bigint): Promise<OrderContext> {
  const session = await prisma.session.findFirst({
    where: {
      telegramId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (session) {
    return JSON.parse(session.context) as OrderContext;
  }

  return { step: 'idle' };
}

export async function updateSession(telegramId: bigint, context: OrderContext): Promise<void> {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  // Upsert session
  await prisma.session.deleteMany({
    where: { telegramId },
  });

  await prisma.session.create({
    data: {
      telegramId,
      context: JSON.stringify(context),
      expiresAt,
    },
  });
}

export async function clearSession(telegramId: bigint): Promise<void> {
  await prisma.session.deleteMany({
    where: { telegramId },
  });
}

