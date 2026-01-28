'use client';

import { useState, useEffect } from 'react';

const CORRECT_PASSWORD = 'silver';
const STORAGE_KEY = 'goldbug_analytics_auth';

interface PasswordGateProps {
  children: React.ReactNode;
}

export default function PasswordGate({ children }: PasswordGateProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if already authenticated
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored === 'true') {
      setIsAuthenticated(true);
    }
    setIsLoading(false);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === CORRECT_PASSWORD) {
      sessionStorage.setItem(STORAGE_KEY, 'true');
      setIsAuthenticated(true);
      setError('');
    } else {
      setError('Incorrect password');
      setPassword('');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-600 mb-4">
              <span className="text-3xl">📊</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">
              <span className="text-gold-gradient">GOLD</span>Bug Analytics
            </h1>
            <p className="text-zinc-500 text-sm">Enter password to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-gold-500 transition-colors"
                autoFocus
              />
              {error && (
                <p className="mt-2 text-red-400 text-sm">{error}</p>
              )}
            </div>
            <button
              type="submit"
              className="w-full py-3 bg-gradient-to-r from-gold-600 to-gold-500 text-black font-semibold rounded-lg hover:from-gold-500 hover:to-gold-400 transition-all"
            >
              Access Dashboard
            </button>
          </form>

          <p className="mt-6 text-center text-zinc-600 text-xs">
            GoldBug Internal Analytics
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

