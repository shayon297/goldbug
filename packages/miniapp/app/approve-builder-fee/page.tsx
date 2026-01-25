'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { expandMiniApp, getTelegramUser, closeMiniApp } from '@/lib/telegram';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const BUILDER_ADDRESS = process.env.NEXT_PUBLIC_BUILDER_ADDRESS || '';
const BUILDER_MAX_FEE_RATE = '0.1%'; // Maximum builder fee rate

export default function ApproveBuilderFeePage() {
  const privy = usePrivy();
  const { ready, authenticated, login } = privy;
  const { wallets } = useWallets();
  const [step, setStep] = useState<'init' | 'approving' | 'success' | 'error'>('init');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    expandMiniApp();
  }, []);

  useEffect(() => {
    if (ready && !authenticated) {
      login();
    }
  }, [ready, authenticated, login]);

  const handleApprove = useCallback(async () => {
    if (!authenticated || wallets.length === 0) {
      setError('Please connect your wallet first');
      return;
    }

    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    if (!embeddedWallet) {
      setError('No embedded wallet found');
      return;
    }

    setStep('approving');
    setError(null);

    try {
      const provider = await embeddedWallet.getEthereumProvider();
      const nonce = Date.now();

      const typedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42161, // Arbitrum One mainnet
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          'HyperliquidTransaction:ApproveBuilderFee': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'maxFeeRate', type: 'string' },
            { name: 'builder', type: 'address' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
        message: {
          hyperliquidChain: 'Mainnet',
          maxFeeRate: BUILDER_MAX_FEE_RATE,
          builder: BUILDER_ADDRESS.toLowerCase(),
          nonce,
        },
      };

      const signature = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [embeddedWallet.address, JSON.stringify(typedData)],
      });

      const response = await fetch(`${API_URL}/api/approve-builder-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: embeddedWallet.address,
          signature,
          nonce,
        }),
      });

      const result = await response.json();

      if (response.ok && result?.response?.status === 'ok') {
        setStep('success');

        // Notify backend to execute pending order
        const telegramUser = getTelegramUser();
        if (telegramUser) {
          try {
            await fetch(`${API_URL}/api/builder-fee-approved`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ telegramUserId: telegramUser.id.toString() }),
            });
          } catch (err) {
            console.warn('Failed to notify backend:', err);
          }
        }

        // Close Mini App after 2 seconds
        setTimeout(() => {
          closeMiniApp();
        }, 2000);
      } else {
        const errorMsg = result?.response?.response || result?.error || 'Builder fee approval failed';
        setError(errorMsg);
        setStep('error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setStep('error');
    }
  }, [authenticated, wallets]);

  if (!ready || !authenticated || wallets.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-900 text-white">
        <div className="text-center">
          <div className="spinner mx-auto mb-4" />
          <p>Connecting wallet...</p>
        </div>
      </div>
    );
  }

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-6">
      <div className="max-w-md mx-auto">
        {step === 'init' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">💸</span>
            </div>
            <h1 className="text-2xl font-bold mb-2">Approve Builder Fee</h1>
            <p className="text-zinc-400 mb-6">
              Approve the builder fee to enable trading. This is a one-time action.
            </p>
            {embeddedWallet && (
              <div className="bg-zinc-800/50 rounded-lg p-3 mb-6 text-left">
                <p className="text-xs text-zinc-500 mb-1">Wallet</p>
                <p className="text-sm font-mono text-zinc-300 break-all">{embeddedWallet.address}</p>
              </div>
            )}
            <button
              onClick={handleApprove}
              className="w-full bg-gold-500 hover:bg-gold-600 text-black font-semibold py-3 px-6 rounded-lg transition"
            >
              Approve Builder Fee
            </button>
          </div>
        )}

        {step === 'approving' && (
          <div className="text-center">
            <div className="spinner mx-auto mb-4" />
            <p className="text-zinc-400">Approving builder fee...</p>
          </div>
        )}

        {step === 'success' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2 text-green-500">Approved!</h2>
            <p className="text-zinc-400">Your order will execute automatically...</p>
          </div>
        )}

        {step === 'error' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2 text-red-500">Approval Failed</h2>
            <p className="text-zinc-400 mb-6">{error}</p>
            <button
              onClick={() => {
                setStep('init');
                setError(null);
              }}
              className="w-full bg-zinc-700 hover:bg-zinc-600 text-white font-semibold py-3 px-6 rounded-lg transition"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

