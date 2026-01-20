'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { Wallet, ethers } from 'ethers';
import {
  getTelegramUser,
  getTelegramInitData,
  closeMiniApp,
  expandMiniApp,
} from '@/lib/telegram';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

type Step = 'init' | 'login' | 'authorize' | 'registering' | 'success' | 'error';

export default function Home() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const { wallets } = useWallets();

  const [step, setStep] = useState<Step>('init');
  const [error, setError] = useState<string | null>(null);
  const [telegramUser, setTelegramUser] = useState<{ id: number; firstName: string } | null>(null);

  // Initialize Telegram Web App
  useEffect(() => {
    expandMiniApp();
    const user = getTelegramUser();
    setTelegramUser(user);

    if (!user) {
      setError('Please open this app from Telegram');
      setStep('error');
    }
  }, []);

  // Update step based on Privy state
  useEffect(() => {
    if (!ready) return;

    if (authenticated && wallets.length > 0) {
      setStep('authorize');
    } else if (!authenticated) {
      setStep('login');
    }
  }, [ready, authenticated, wallets]);

  // Handle login
  const handleLogin = useCallback(async () => {
    try {
      login();
    } catch (err) {
      setError('Login failed. Please try again.');
      setStep('error');
    }
  }, [login]);

  // Handle agent authorization and registration
  const handleAuthorize = useCallback(async () => {
    if (!telegramUser || wallets.length === 0) return;

    setStep('registering');
    setError(null);

    try {
      // Get the embedded wallet
      const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
      if (!embeddedWallet) {
        throw new Error('No embedded wallet found. Please try logging in again.');
      }

      // Generate a new agent wallet
      const agentWallet = Wallet.createRandom();
      const agentAddress = agentWallet.address;
      const agentPrivateKey = agentWallet.privateKey;

      // Get Privy access token
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Failed to get authentication token');
      }

      // Get Telegram init data for verification
      const initData = getTelegramInitData();

      // Register with backend
      const response = await fetch(`${API_URL}/api/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(initData && { 'X-Telegram-Init-Data': initData }),
        },
        body: JSON.stringify({
          privyToken: accessToken,
          telegramUserId: telegramUser.id.toString(),
          agentAddress,
          agentPrivateKey,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Registration failed');
      }

      setStep('success');

      // Auto-close after success
      setTimeout(() => {
        closeMiniApp();
      }, 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setStep('error');
    }
  }, [telegramUser, wallets, getAccessToken]);

  // Render loading state
  if (!ready || step === 'init') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="spinner mx-auto mb-4" />
          <p className="text-zinc-400">Initializing...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-gold-gradient mb-2">GOLD Trade</h1>
        <p className="text-zinc-400">Trade GOLD with up to 20x leverage</p>
      </div>

      {/* Card */}
      <div className="card w-full max-w-sm">
        {/* Login Step */}
        {step === 'login' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-gold-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold mb-2">Connect Wallet</h2>
            <p className="text-zinc-400 text-sm mb-6">
              Sign in to create your trading wallet
            </p>

            <button onClick={handleLogin} className="btn-gold w-full">
              Connect with Privy
            </button>
          </div>
        )}

        {/* Authorize Step */}
        {step === 'authorize' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-gold-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold mb-2">Enable Trading</h2>
            <p className="text-zinc-400 text-sm mb-6">
              Authorize the bot to trade on your behalf. You can revoke access anytime.
            </p>

            <div className="bg-zinc-800/50 rounded-lg p-3 mb-6 text-left">
              <p className="text-xs text-zinc-500 mb-1">Connected Wallet</p>
              <p className="text-sm font-mono text-zinc-300 truncate">
                {wallets[0]?.address}
              </p>
            </div>

            <button onClick={handleAuthorize} className="btn-gold w-full">
              Enable Trading
            </button>
          </div>
        )}

        {/* Registering Step */}
        {step === 'registering' && (
          <div className="text-center py-8">
            <div className="spinner mx-auto mb-4" />
            <p className="text-zinc-400">Setting up your account...</p>
          </div>
        )}

        {/* Success Step */}
        {step === 'success' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold mb-2 text-green-500">Connected!</h2>
            <p className="text-zinc-400 text-sm mb-4">
              You can now trade GOLD in Telegram.
            </p>
            <p className="text-zinc-500 text-xs">Closing automatically...</p>
          </div>
        )}

        {/* Error Step */}
        {step === 'error' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold mb-2 text-red-500">Error</h2>
            <p className="text-zinc-400 text-sm mb-6">{error}</p>

            <button
              onClick={() => {
                setError(null);
                setStep(authenticated ? 'authorize' : 'login');
              }}
              className="btn-outline w-full"
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-8 text-center">
        <p className="text-zinc-600 text-xs">
          Powered by Hyperliquid & Privy
        </p>
      </div>
    </main>
  );
}

