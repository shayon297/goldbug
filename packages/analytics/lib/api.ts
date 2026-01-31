import 'server-only';

const API_URL = 'https://goldbug-production.up.railway.app';
const API_KEY = 'goldbug-analytics-2026-secure';

async function fetchAnalytics<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_URL}/api/analytics/${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }
  url.searchParams.set('apiKey', API_KEY);

  const response = await fetch(url.toString(), {
    headers: {
      'x-api-key': API_KEY,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  return response.json();
}

export interface OverviewData {
  users: {
    total: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
  activity: {
    signups: number;
    trades: number;
    firstTrades: number;
    sessions: number;
    conversionRate: number;
  };
  timestamp: number;
}

export interface UserGrowthData {
  data: Array<{
    date: string;
    newUsers: number;
    totalUsers: number;
  }>;
  timestamp: number;
}

export interface RetentionData {
  cohorts: Array<{
    cohortWeek: string;
    cohortSize: number;
    retention: number[];
  }>;
  timestamp: number;
}

export interface FunnelData {
  funnel: {
    signups: number;
    walletConnected: number;
    agentApproved: number;
    firstTrade: number;
    totalTrades: number;
  };
  rates: {
    signupToWallet: number;
    walletToApproved: number;
    approvedToFirstTrade: number;
    overallConversion: number;
  };
  timestamp: number;
}

export interface EngagementData {
  dau: number;
  wau: number;
  mau: number;
  totalUsers: number;
  stickiness: number;
  dailyActiveData: Array<{
    date: string;
    dau: number;
  }>;
  timestamp: number;
}

export interface TradesData {
  totalTrades: number;
  totalVolume: number;
  avgTradeSize: number;
  longCount: number;
  shortCount: number;
  leverageDistribution: Record<number, number>;
  dailyVolumeData: Array<{
    date: string;
    volume: number;
  }>;
  timestamp: number;
}

export interface AllAnalyticsData {
  overview: OverviewData | null;
  userGrowth: UserGrowthData | null;
  retention: RetentionData | null;
  funnel: FunnelData | null;
  engagement: EngagementData | null;
  trades: TradesData | null;
  error: string | null;
  timestamp: number;
}

export async function fetchAllAnalytics(): Promise<AllAnalyticsData> {
  try {
    const [overview, userGrowth, retention, funnel, engagement, trades] = await Promise.all([
      fetchAnalytics<OverviewData>('overview'),
      fetchAnalytics<UserGrowthData>('users', { days: '30' }),
      fetchAnalytics<RetentionData>('retention', { weeks: '8' }),
      fetchAnalytics<FunnelData>('funnel', { days: '30' }),
      fetchAnalytics<EngagementData>('engagement'),
      fetchAnalytics<TradesData>('trades', { days: '30' }),
    ]);

    return {
      overview,
      userGrowth,
      retention,
      funnel,
      engagement,
      trades,
      error: null,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error('Failed to fetch analytics:', err);
    return {
      overview: null,
      userGrowth: null,
      retention: null,
      funnel: null,
      engagement: null,
      trades: null,
      error: err instanceof Error ? err.message : 'Failed to load analytics',
      timestamp: Date.now(),
    };
  }
}
