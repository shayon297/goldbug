'use client';

import { useEffect, useState, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://goldbug-production.up.railway.app';
const BOT_LINK = process.env.NEXT_PUBLIC_BOT_LINK || 'https://t.me/goldbug_tradingbot';
const WEBSITE_LINK = process.env.NEXT_PUBLIC_WEBSITE_LINK || 'https://goldbug.app';
const SUPPORT_LINK = process.env.NEXT_PUBLIC_SUPPORT_LINK || 'https://t.me/goldbug_support';
const DOCS_LINK = process.env.NEXT_PUBLIC_DOCS_LINK || 'https://docs.goldbug.app';
const TWITTER_LINK = process.env.NEXT_PUBLIC_TWITTER_LINK || 'https://x.com/goldbug_app';

interface LeaderboardEntry {
  rank: number;
  wallet: string;
  volume: number;
  pnl: number;
  points: number;
}

function formatWallet(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(num: number, decimals: number = 2): string {
  if (Math.abs(num) >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (Math.abs(num) >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toFixed(decimals);
}

function formatPnl(pnl: number): { text: string; color: string } {
  const prefix = pnl >= 0 ? '+' : '';
  return {
    text: `${prefix}$${formatNumber(pnl)}`,
    color: pnl >= 0 ? 'text-emerald-400' : 'text-red-400',
  };
}

export default function HomePage() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [goldPrice, setGoldPrice] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'volume' | 'pnl' | 'points'>('volume');

  const fetchLeaderboard = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/leaderboard`);
      if (res.ok) {
        const data = await res.json();
        setLeaderboard(data.leaderboard || []);
      }
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/price`);
      if (res.ok) {
        const data = await res.json();
        setGoldPrice(data.price);
      }
    } catch (err) {
      console.error('Failed to fetch price:', err);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard();
    fetchPrice();

    const interval = setInterval(() => {
      fetchLeaderboard();
      fetchPrice();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchLeaderboard, fetchPrice]);

  const sortedLeaderboard = [...leaderboard].sort((a, b) => {
    switch (activeTab) {
      case 'volume':
        return b.volume - a.volume;
      case 'pnl':
        return b.pnl - a.pnl;
      case 'points':
        return b.points - a.points;
      default:
        return 0;
    }
  });

  return (
    <main className="min-h-screen bg-[#0a0a0a] overflow-hidden">
      {/* Animated background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-radial from-gold-500/10 via-transparent to-transparent animate-pulse-slow" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-radial from-amber-600/5 via-transparent to-transparent animate-pulse-slower" />
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAwIDEwIEwgNDAgMTAgTSAxMCAwIEwgMTAgNDAgTSAwIDIwIEwgNDAgMjAgTSAyMCAwIEwgMjAgNDAgTSAwIDMwIEwgNDAgMzAgTSAzMCAwIEwgMzAgNDAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI1MjUyNSIgc3Ryb2tlLXdpZHRoPSIwLjUiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] opacity-30" />
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-6xl mx-auto px-4 py-8 sm:py-16">
        {/* Hero Section */}
        <header className="text-center mb-16 sm:mb-24">
          {/* Logo/Brand */}
          <div className="inline-flex items-center justify-center mb-6 animate-fade-in">
            <div className="relative">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-gradient-to-br from-gold-400 via-gold-500 to-amber-600 flex items-center justify-center shadow-2xl shadow-gold-500/30 animate-float">
                <span className="text-4xl sm:text-5xl">🪙</span>
              </div>
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-gold-400 to-amber-600 opacity-20 blur-xl animate-pulse-slow" />
            </div>
          </div>

          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold mb-4 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
            <span className="text-gold-gradient">GOLD</span>
            <span className="text-white">Bug</span>
          </h1>

          <p className="text-lg sm:text-xl text-zinc-400 max-w-2xl mx-auto mb-8 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
            Trade tokenized gold with up to <span className="text-gold-400 font-semibold">20x leverage</span> directly from Telegram.
            Powered by Hyperliquid.
          </p>

          {/* Live Price */}
          {goldPrice && (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900/80 border border-zinc-800 backdrop-blur-sm animate-fade-in-up" style={{ animationDelay: '0.3s' }}>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-zinc-400 text-sm">GOLD</span>
              <span className="text-white font-mono font-semibold">${goldPrice.toFixed(2)}</span>
            </div>
          )}
        </header>

        {/* Quick Links */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-16 sm:mb-24 animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
          <a
            href={BOT_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-gradient-to-br from-blue-600/20 to-blue-800/20 border border-blue-500/30 hover:border-blue-400/60 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl hover:shadow-blue-500/10"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="text-3xl mb-2">🤖</span>
            <span className="text-sm font-semibold text-blue-400">Start Trading</span>
            <span className="text-xs text-zinc-500 mt-1">Open Bot</span>
          </a>

          <a
            href={TWITTER_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-gradient-to-br from-zinc-600/20 to-zinc-800/20 border border-zinc-500/30 hover:border-zinc-400/60 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl hover:shadow-zinc-500/10"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-zinc-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="text-3xl mb-2">𝕏</span>
            <span className="text-sm font-semibold text-zinc-300">Twitter</span>
            <span className="text-xs text-zinc-500 mt-1">Follow Us</span>
          </a>

          <a
            href={DOCS_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-gradient-to-br from-purple-600/20 to-purple-800/20 border border-purple-500/30 hover:border-purple-400/60 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl hover:shadow-purple-500/10"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="text-3xl mb-2">📚</span>
            <span className="text-sm font-semibold text-purple-400">Docs</span>
            <span className="text-xs text-zinc-500 mt-1">How it Works</span>
          </a>

          <a
            href={SUPPORT_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex flex-col items-center justify-center p-6 rounded-2xl bg-gradient-to-br from-emerald-600/20 to-emerald-800/20 border border-emerald-500/30 hover:border-emerald-400/60 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl hover:shadow-emerald-500/10"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="text-3xl mb-2">💬</span>
            <span className="text-sm font-semibold text-emerald-400">Support</span>
            <span className="text-xs text-zinc-500 mt-1">Get Help</span>
          </a>
        </section>

        {/* Leaderboard Section */}
        <section className="animate-fade-in-up" style={{ animationDelay: '0.5s' }}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white">
                <span className="text-gold-gradient">🏆</span> Leaderboard
              </h2>
              <p className="text-zinc-500 text-sm mt-1">Top traders on GoldBug</p>
            </div>

            {/* Tab Switcher */}
            <div className="flex gap-1 p-1 rounded-xl bg-zinc-900/80 border border-zinc-800">
              {(['volume', 'pnl', 'points'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                    activeTab === tab
                      ? 'bg-gold-500 text-black shadow-lg'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                  }`}
                >
                  {tab === 'volume' && '📊 Volume'}
                  {tab === 'pnl' && '💰 PnL'}
                  {tab === 'points' && '⭐ Points'}
                </button>
              ))}
            </div>
          </div>

          {/* Leaderboard Table */}
          <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800 backdrop-blur-sm overflow-hidden">
            {/* Table Header */}
            <div className="grid grid-cols-12 gap-2 px-4 sm:px-6 py-4 bg-zinc-800/50 border-b border-zinc-700/50 text-xs sm:text-sm font-semibold text-zinc-400">
              <div className="col-span-1 text-center">#</div>
              <div className="col-span-4 sm:col-span-3">Trader</div>
              <div className="col-span-3 sm:col-span-3 text-right">Volume</div>
              <div className="col-span-2 sm:col-span-3 text-right">PnL</div>
              <div className="col-span-2 text-right">Points</div>
            </div>

            {/* Table Body */}
            <div className="divide-y divide-zinc-800/50">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 px-4 sm:px-6 py-4 animate-pulse">
                    <div className="col-span-1 flex justify-center">
                      <div className="w-6 h-6 rounded-full bg-zinc-800" />
                    </div>
                    <div className="col-span-4 sm:col-span-3">
                      <div className="h-4 bg-zinc-800 rounded w-24" />
                    </div>
                    <div className="col-span-3 sm:col-span-3 flex justify-end">
                      <div className="h-4 bg-zinc-800 rounded w-16" />
                    </div>
                    <div className="col-span-2 sm:col-span-3 flex justify-end">
                      <div className="h-4 bg-zinc-800 rounded w-12" />
                    </div>
                    <div className="col-span-2 flex justify-end">
                      <div className="h-4 bg-zinc-800 rounded w-10" />
                    </div>
                  </div>
                ))
              ) : sortedLeaderboard.length === 0 ? (
                <div className="px-6 py-12 text-center text-zinc-500">
                  <span className="text-4xl block mb-2">📊</span>
                  No traders yet. Be the first!
                </div>
              ) : (
                sortedLeaderboard.slice(0, 20).map((entry, index) => {
                  const pnlFormatted = formatPnl(entry.pnl);
                  const isTopThree = index < 3;
                  
                  return (
                    <div
                      key={entry.wallet}
                      className={`grid grid-cols-12 gap-2 px-4 sm:px-6 py-4 hover:bg-zinc-800/30 transition-colors ${
                        isTopThree ? 'bg-gold-500/5' : ''
                      }`}
                    >
                      <div className="col-span-1 flex justify-center items-center">
                        {index === 0 && <span className="text-xl">🥇</span>}
                        {index === 1 && <span className="text-xl">🥈</span>}
                        {index === 2 && <span className="text-xl">🥉</span>}
                        {index > 2 && (
                          <span className="text-zinc-500 font-mono text-sm">{index + 1}</span>
                        )}
                      </div>
                      <div className="col-span-4 sm:col-span-3 flex items-center">
                        <span className="font-mono text-sm text-zinc-300">
                          {formatWallet(entry.wallet)}
                        </span>
                      </div>
                      <div className="col-span-3 sm:col-span-3 flex items-center justify-end">
                        <span className={`font-mono text-sm ${activeTab === 'volume' ? 'text-gold-400 font-semibold' : 'text-zinc-400'}`}>
                          ${formatNumber(entry.volume)}
                        </span>
                      </div>
                      <div className="col-span-2 sm:col-span-3 flex items-center justify-end">
                        <span className={`font-mono text-sm ${activeTab === 'pnl' ? 'font-semibold' : ''} ${pnlFormatted.color}`}>
                          {pnlFormatted.text}
                        </span>
                      </div>
                      <div className="col-span-2 flex items-center justify-end">
                        <span className={`font-mono text-sm ${activeTab === 'points' ? 'text-amber-400 font-semibold' : 'text-zinc-400'}`}>
                          {entry.points.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="mt-4 text-center">
            <p className="text-zinc-600 text-xs">
              Updated every 30 seconds • Trade more to climb the ranks!
            </p>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-16 sm:mt-24 pt-8 border-t border-zinc-800/50">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🪙</span>
              <span className="text-lg font-bold">
                <span className="text-gold-gradient">GOLD</span>
                <span className="text-white">Bug</span>
              </span>
            </div>
            
            <p className="text-zinc-600 text-sm text-center">
              Powered by <span className="text-zinc-400">Hyperliquid</span> & <span className="text-zinc-400">Privy</span>
            </p>

            <div className="flex items-center gap-4">
              <a href={BOT_LINK} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-gold-400 transition-colors text-sm">
                Telegram
              </a>
              <a href={TWITTER_LINK} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-gold-400 transition-colors text-sm">
                Twitter
              </a>
              <a href={SUPPORT_LINK} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-gold-400 transition-colors text-sm">
                Support
              </a>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

