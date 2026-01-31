'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import MetricCard from '@/components/MetricCard';
import {
  UserGrowthChart,
  EngagementChart,
  VolumeChart,
  FunnelChart,
  LeverageDistributionChart,
  RetentionTable,
} from '@/components/Charts';
import type {
  OverviewData,
  UserGrowthData,
  RetentionData,
  FunnelData,
  EngagementData,
  TradesData,
} from '@/lib/api';

type TabId = 'overview' | 'users' | 'engagement' | 'conversion' | 'trades';

interface DashboardProps {
  overview: OverviewData | null;
  userGrowth: UserGrowthData | null;
  retention: RetentionData | null;
  funnel: FunnelData | null;
  engagement: EngagementData | null;
  trades: TradesData | null;
  error: string | null;
  timestamp: number;
}

export default function Dashboard({
  overview,
  userGrowth,
  retention,
  funnel,
  engagement,
  trades,
  error,
  timestamp,
}: DashboardProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = () => {
    setIsRefreshing(true);
    router.refresh();
    // Reset refreshing state after a delay
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const tabs: Array<{ id: TabId; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'users', label: 'Users', icon: '👥' },
    { id: 'engagement', label: 'Engagement', icon: '🔥' },
    { id: 'conversion', label: 'Conversion', icon: '🎯' },
    { id: 'trades', label: 'Trades', icon: '💹' },
  ];

  const lastUpdated = new Date(timestamp);

  return (
    <main className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center">
                <span className="text-xl">📊</span>
              </div>
              <div>
                <h1 className="text-lg font-bold text-white">
                  <span className="text-gold-gradient">GOLD</span>Bug Analytics
                </h1>
                <p className="text-xs text-zinc-500">
                  Updated {lastUpdated.toLocaleTimeString()}
                </p>
              </div>
            </div>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors disabled:opacity-50"
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {/* Tabs */}
          <nav className="flex gap-1 mt-4 overflow-x-auto pb-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
                  activeTab === tab.id
                    ? 'bg-gold-500 text-black'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {error ? (
          <div className="card p-8 text-center">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={handleRefresh}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : !overview ? (
          <div className="card p-8 text-center">
            <div className="inline-block w-8 h-8 border-2 border-gold-500 border-t-transparent rounded-full animate-spin" />
            <p className="mt-4 text-zinc-500">Loading analytics...</p>
          </div>
        ) : (
          <>
            {/* Overview Tab */}
            {activeTab === 'overview' && overview && (
              <div className="space-y-6 animate-fade-in">
                {/* Key Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <MetricCard
                    title="Total Users"
                    value={overview.users.total}
                    subtitle={`+${overview.users.thisMonth} this month`}
                    icon="👥"
                    className="animate-fade-in-up stagger-1"
                  />
                  <MetricCard
                    title="Users Today"
                    value={overview.users.today}
                    subtitle={`${overview.users.thisWeek} this week`}
                    icon="📈"
                    className="animate-fade-in-up stagger-2"
                  />
                  <MetricCard
                    title="Total Trades"
                    value={overview.activity.trades}
                    subtitle="Last 30 days"
                    icon="💹"
                    className="animate-fade-in-up stagger-3"
                  />
                  <MetricCard
                    title="Conversion"
                    value={`${overview.activity.conversionRate.toFixed(1)}%`}
                    subtitle="Signup to first trade"
                    icon="🎯"
                    className="animate-fade-in-up stagger-4"
                  />
                </div>

                {/* Charts Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {userGrowth && (
                    <div className="animate-fade-in-up stagger-5">
                      <UserGrowthChart data={userGrowth.data} />
                    </div>
                  )}
                  {engagement && (
                    <div className="animate-fade-in-up stagger-6">
                      <EngagementChart data={engagement.dailyActiveData} />
                    </div>
                  )}
                </div>

                {/* Engagement Summary */}
                {engagement && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <MetricCard
                      title="DAU"
                      value={engagement.dau}
                      subtitle="Daily Active Users"
                      icon="📅"
                    />
                    <MetricCard
                      title="WAU"
                      value={engagement.wau}
                      subtitle="Weekly Active Users"
                      icon="📆"
                    />
                    <MetricCard
                      title="MAU"
                      value={engagement.mau}
                      subtitle="Monthly Active Users"
                      icon="🗓️"
                    />
                    <MetricCard
                      title="Stickiness"
                      value={`${engagement.stickiness.toFixed(1)}%`}
                      subtitle="DAU/MAU ratio"
                      icon="🧲"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Users Tab */}
            {activeTab === 'users' && (
              <div className="space-y-6 animate-fade-in">
                {overview && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <MetricCard
                      title="Total Users"
                      value={overview.users.total}
                      icon="👥"
                    />
                    <MetricCard
                      title="Today"
                      value={overview.users.today}
                      icon="📅"
                    />
                    <MetricCard
                      title="This Week"
                      value={overview.users.thisWeek}
                      icon="📆"
                    />
                    <MetricCard
                      title="This Month"
                      value={overview.users.thisMonth}
                      icon="🗓️"
                    />
                  </div>
                )}

                {userGrowth && <UserGrowthChart data={userGrowth.data} />}
                {retention && <RetentionTable cohorts={retention.cohorts} />}
              </div>
            )}

            {/* Engagement Tab */}
            {activeTab === 'engagement' && engagement && (
              <div className="space-y-6 animate-fade-in">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <MetricCard
                    title="DAU"
                    value={engagement.dau}
                    subtitle="Daily Active Users"
                    icon="📅"
                  />
                  <MetricCard
                    title="WAU"
                    value={engagement.wau}
                    subtitle="Weekly Active Users"
                    icon="📆"
                  />
                  <MetricCard
                    title="MAU"
                    value={engagement.mau}
                    subtitle="Monthly Active Users"
                    icon="🗓️"
                  />
                  <MetricCard
                    title="Stickiness"
                    value={`${engagement.stickiness.toFixed(1)}%`}
                    subtitle="DAU/MAU ratio"
                    icon="🧲"
                  />
                </div>

                <EngagementChart data={engagement.dailyActiveData} />
                {retention && <RetentionTable cohorts={retention.cohorts} />}
              </div>
            )}

            {/* Conversion Tab */}
            {activeTab === 'conversion' && funnel && (
              <div className="space-y-6 animate-fade-in">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <MetricCard
                    title="Signups"
                    value={funnel.funnel.signups}
                    icon="✍️"
                  />
                  <MetricCard
                    title="Wallet Connected"
                    value={funnel.funnel.walletConnected}
                    subtitle={`${funnel.rates.signupToWallet.toFixed(1)}% of signups`}
                    icon="👛"
                  />
                  <MetricCard
                    title="Agent Approved"
                    value={funnel.funnel.agentApproved}
                    subtitle={`${funnel.rates.walletToApproved.toFixed(1)}% of wallets`}
                    icon="🔐"
                  />
                  <MetricCard
                    title="First Trade"
                    value={funnel.funnel.firstTrade}
                    subtitle={`${funnel.rates.overallConversion.toFixed(1)}% overall`}
                    icon="🎯"
                  />
                </div>

                <FunnelChart funnel={funnel.funnel} />

                <div className="card p-6">
                  <h3 className="text-lg font-semibold text-white mb-4">Conversion Rates</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-gold-400">{funnel.rates.signupToWallet.toFixed(1)}%</p>
                      <p className="text-xs text-zinc-500 mt-1">Signup → Wallet</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gold-400">{funnel.rates.walletToApproved.toFixed(1)}%</p>
                      <p className="text-xs text-zinc-500 mt-1">Wallet → Approved</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gold-400">{funnel.rates.approvedToFirstTrade.toFixed(1)}%</p>
                      <p className="text-xs text-zinc-500 mt-1">Approved → Trade</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-emerald-400">{funnel.rates.overallConversion.toFixed(1)}%</p>
                      <p className="text-xs text-zinc-500 mt-1">Overall Conversion</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Trades Tab */}
            {activeTab === 'trades' && trades && (
              <div className="space-y-6 animate-fade-in">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <MetricCard
                    title="Total Trades"
                    value={trades.totalTrades}
                    icon="💹"
                  />
                  <MetricCard
                    title="Total Volume"
                    value={`$${(trades.totalVolume / 1000).toFixed(1)}k`}
                    icon="💰"
                  />
                  <MetricCard
                    title="Avg Trade Size"
                    value={`$${trades.avgTradeSize.toFixed(0)}`}
                    icon="📏"
                  />
                  <MetricCard
                    title="Long/Short"
                    value={`${trades.longCount}/${trades.shortCount}`}
                    subtitle={`${((trades.longCount / (trades.longCount + trades.shortCount || 1)) * 100).toFixed(0)}% long`}
                    icon="⚖️"
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <VolumeChart data={trades.dailyVolumeData} />
                  <LeverageDistributionChart distribution={trades.leverageDistribution} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-800 mt-12">
        <div className="max-w-7xl mx-auto px-4 py-4 text-center text-zinc-600 text-xs">
          GoldBug Analytics Dashboard • Internal Use Only
        </div>
      </footer>
    </main>
  );
}

