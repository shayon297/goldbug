import { prisma } from './db.js';

// Event types for tracking conversion funnel
export const EVENT_TYPES = {
  // Registration funnel
  SIGNUP: 'signup',
  WALLET_CONNECTED: 'wallet_connected',
  AGENT_APPROVED: 'agent_approved',
  BUILDER_FEE_APPROVED: 'builder_fee_approved',
  
  // Onramp funnel
  ONRAMP_STARTED: 'onramp_started',
  ONRAMP_COMPLETED: 'onramp_completed',
  BRIDGE_STARTED: 'bridge_started',
  BRIDGE_COMPLETED: 'bridge_completed',
  
  // Trading funnel
  FIRST_TRADE: 'first_trade',
  TRADE_EXECUTED: 'trade_executed',
  
  // Engagement
  BOT_COMMAND: 'bot_command',
  SESSION_START: 'session_start',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

interface TrackEventParams {
  telegramId?: bigint | string | number;
  eventType: EventType;
  metadata?: Record<string, unknown>;
}

/**
 * Track an analytics event
 */
export async function trackEvent({ telegramId, eventType, metadata }: TrackEventParams): Promise<void> {
  try {
    const parsedTelegramId = telegramId 
      ? BigInt(typeof telegramId === 'bigint' ? telegramId : telegramId)
      : null;

    await prisma.analyticsEvent.create({
      data: {
        telegramId: parsedTelegramId,
        eventType,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });
  } catch (error) {
    // Don't let analytics errors break the main flow
    console.error('[Analytics] Failed to track event:', error);
  }
}

/**
 * Get event counts by type for a date range
 */
export async function getEventCounts(
  startDate: Date,
  endDate: Date,
  eventTypes?: EventType[]
): Promise<Record<string, number>> {
  const where: Record<string, unknown> = {
    createdAt: {
      gte: startDate,
      lte: endDate,
    },
  };

  if (eventTypes && eventTypes.length > 0) {
    where.eventType = { in: eventTypes };
  }

  const events = await prisma.analyticsEvent.groupBy({
    by: ['eventType'],
    where,
    _count: true,
  });

  return events.reduce((acc, event) => {
    acc[event.eventType] = event._count;
    return acc;
  }, {} as Record<string, number>);
}

/**
 * Get unique users who performed an event type
 */
export async function getUniqueUsersForEvent(
  eventType: EventType,
  startDate: Date,
  endDate: Date
): Promise<number> {
  const result = await prisma.analyticsEvent.findMany({
    where: {
      eventType,
      telegramId: { not: null },
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    select: {
      telegramId: true,
    },
    distinct: ['telegramId'],
  });

  return result.length;
}

/**
 * Get daily event counts for a time series chart
 */
export async function getDailyEventCounts(
  eventType: EventType,
  days: number = 30
): Promise<Array<{ date: string; count: number }>> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const events = await prisma.analyticsEvent.findMany({
    where: {
      eventType,
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    select: {
      createdAt: true,
    },
  });

  // Group by date
  const countsByDate: Record<string, number> = {};
  
  // Initialize all dates to 0
  for (let i = 0; i <= days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    countsByDate[dateStr] = 0;
  }

  // Count events by date
  for (const event of events) {
    const dateStr = event.createdAt.toISOString().split('T')[0];
    if (countsByDate[dateStr] !== undefined) {
      countsByDate[dateStr]++;
    }
  }

  return Object.entries(countsByDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Check if a user has performed an event before
 */
export async function hasUserEvent(telegramId: bigint, eventType: EventType): Promise<boolean> {
  const event = await prisma.analyticsEvent.findFirst({
    where: {
      telegramId,
      eventType,
    },
  });
  return !!event;
}

