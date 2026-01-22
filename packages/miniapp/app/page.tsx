'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePrivy, useWallets, useFundWallet } from '@privy-io/react-auth';
import { Wallet, ethers, Contract, formatUnits, parseUnits } from 'ethers';
import { arbitrum } from 'viem/chains';
import {
  getTelegramUser,
  getTelegramInitData,
  closeMiniApp,
  expandMiniApp,
} from '@/lib/telegram';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

// Arbitrum USDC and Hyperliquid Bridge
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // Native USDC on Arbitrum
const HYPERLIQUID_BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

type Step = 'init' | 'login' | 'authorize' | 'registering' | 'success' | 'bridge' | 'bridging' | 'bridged' | 'onramp' | 'error';

export default function Home() {
  const privy = usePrivy();
  const { ready, authenticated, login, getAccessToken } = privy;
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();

  const [step, setStep] = useState<Step>('init');
  const [error, setError] = useState<string | null>(null);
  const [telegramUser, setTelegramUser] = useState<{ id: number; firstName: string } | null>(null);
  const [registeredWallet, setRegisteredWallet] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string>('0');
  const [bridgeAmount, setBridgeAmount] = useState<string>('');
  const [ethBalance, setEthBalance] = useState<string>('0');
  const [wantsBridge, setWantsBridge] = useState(false);
  const [wantsReauth, setWantsReauth] = useState(false);
  const [wantsOnramp, setWantsOnramp] = useState(false);
  const [isFunding, setIsFunding] = useState(false);
  const checkedUrl = useRef(false);

  // Initialize Telegram Web App and check URL params
  useEffect(() => {
    expandMiniApp();
    const user = getTelegramUser();
    setTelegramUser(user);

    // Check URL params for actions
    if (!checkedUrl.current) {
      checkedUrl.current = true;
      const params = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
      const action = params.get('action') || hashParams.get('action');
      
      if (action === 'bridge') {
        console.log('[MiniApp] Bridge action detected');
        setWantsBridge(true);
      } else if (action === 'reauth') {
        console.log('[MiniApp] Reauth action detected');
        setWantsReauth(true);
      } else if (action === 'onramp') {
        console.log('[MiniApp] Onramp action detected');
        setWantsOnramp(true);
      }
    }

    if (!user) {
      setError('Please open this app from Telegram');
      setStep('error');
    }
  }, []);

  // Update step based on Privy state
  useEffect(() => {
    if (!ready) return;
    // Don't reset these steps - they should persist until user action
    if (step === 'bridge' || step === 'bridging' || step === 'bridged' || step === 'onramp' ||
        step === 'registering' || step === 'error' || step === 'success' || isFunding) return;

    if (authenticated && wallets.length > 0) {
      if (wantsBridge) {
        console.log('[MiniApp] Going to bridge step');
        setStep('bridge');
      } else if (wantsOnramp) {
        console.log('[MiniApp] Going to onramp step');
        setStep('onramp');
      } else if (wantsReauth) {
        console.log('[MiniApp] Going to authorize step for reauth');
        setStep('authorize');
      } else {
        setStep('authorize');
      }
    } else if (!authenticated) {
      // If user wants onramp but not authenticated, go to login
      if (wantsOnramp) {
        setStep('login');
      } else {
        setStep('login');
      }
    }
  }, [ready, authenticated, wallets, wantsBridge, wantsReauth, wantsOnramp, step, isFunding]);

  // Handle login
  const handleLogin = useCallback(async () => {
    try {
      login();
    } catch (err) {
      setError('Login failed. Please try again.');
      setStep('error');
    }
  }, [login]);

  const handlePrivyFunding = useCallback(async () => {
    // Ensure user is authenticated
    if (!authenticated) {
      setError('Please log in to fund your wallet.');
      setStep('login');
      return;
    }

    // Get embedded wallet address
    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    const address = embeddedWallet?.address || wallets[0]?.address;
    
    if (!address) {
      setError('No wallet address available. Please connect a wallet first.');
      setStep('error');
      return;
    }

    if (!fundWallet) {
      setError('Privy funding is not available. Please refresh the page.');
      setStep('error');
      return;
    }

    setIsFunding(true);
    setError(null);

    try {
      console.log('[MiniApp] Calling fundWallet with:', {
        address,
        chain: arbitrum.id,
        asset: 'USDC',
        amount: '10',
        provider: 'moonpay',
      });

      await fundWallet({
        address,
        options: {
          chain: arbitrum,
          asset: 'USDC',
          amount: '10',
          defaultFundingMethod: 'card',
          card: {
            preferredProvider: 'moonpay',
          },
          uiConfig: {
            receiveFundsTitle: 'Buy USDC on Arbitrum',
            receiveFundsSubtitle: 'Fund your wallet with MoonPay',
          },
        },
      });

      console.log('[MiniApp] Funding modal opened successfully');
      // Don't change step - let Privy modal handle the flow
    } catch (err) {
      setIsFunding(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[MiniApp] Privy funding failed:', err);
      setError(`Funding failed: ${errorMessage}. Please try again or check Privy Dashboard configuration.`);
      setStep('error');
    }
  }, [wallets, fundWallet, authenticated]);

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
      const agentAddress = agentWallet.address.toLowerCase(); // MUST be lowercase
      const agentPrivateKey = agentWallet.privateKey;

      // Get the Ethereum provider from Privy wallet for signing
      const provider = await embeddedWallet.getEthereumProvider();
      
      // Approve agent on Hyperliquid using EIP-712 typed data signing
      // Based on Hyperliquid docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
      const nonce = Date.now();
      // signatureChainId must be Arbitrum One mainnet (42161 = 0xa4b1)
      const signatureChainId = '0xa4b1'; // 42161 - Arbitrum One MAINNET
      
      // EIP-712 message - ONLY the 4 typed fields (no signatureChainId!)
      const eip712Message = {
        hyperliquidChain: 'Mainnet',
        agentAddress: agentAddress,
        agentName: '',
        nonce: nonce,
      };
      
      // EIP-712 typed data - chainId MUST be 42161 (Arbitrum One mainnet)
      const typedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42161, // Arbitrum One mainnet - MUST match signatureChainId
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: eip712Message, // ONLY the 4 typed fields
      };
      
      console.log('[MiniApp] Signing typed data:', JSON.stringify(typedData, null, 2));
      
      const signature = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [embeddedWallet.address, JSON.stringify(typedData)],
      });

      // Parse signature
      const sig = ethers.Signature.from(signature as string);
      console.log('[MiniApp] Signature:', { r: sig.r, s: sig.s, v: sig.v });

      // Send approveAgent to Hyperliquid
      // Action payload for the API - Python SDK DELETES agentName if unnamed
      const apiAction: Record<string, unknown> = {
        type: 'approveAgent',
        hyperliquidChain: 'Mainnet',
        signatureChainId: signatureChainId,
        agentAddress: agentAddress,
        nonce: nonce,
        // agentName is NOT included for unnamed agents (Python SDK deletes it)
      };
      
      const requestBody = {
        action: apiAction,
        nonce: nonce,
        signature: { r: sig.r, s: sig.s, v: sig.v },
      };
      console.log('[MiniApp] Sending to Hyperliquid:', JSON.stringify(requestBody, null, 2));
      
      const hlResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const hlResult = await hlResponse.json();
      console.log('[Hyperliquid] approveAgent result:', JSON.stringify(hlResult));

      // Explicitly verify the approval succeeded
      if (hlResult.status !== 'ok') {
        const errorMsg = hlResult.response || hlResult.error || JSON.stringify(hlResult);
        throw new Error(`Agent approval failed: ${errorMsg}`);
      }
      
      console.log('[Hyperliquid] Agent approved successfully:', agentAddress);

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

      const data = await response.json();
      setRegisteredWallet(data.walletAddress || embeddedWallet.address);
      setStep('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[Authorize] Error:', err);
      setError(message);
      setStep('error');
    }
  }, [telegramUser, wallets, getAccessToken]);

  // Fetch Arbitrum balances
  const fetchBalances = useCallback(async () => {
    if (wallets.length === 0) return;
    
    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    if (!embeddedWallet) return;

    try {
      const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
      const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
      
      const [usdcBal, ethBal] = await Promise.all([
        usdc.balanceOf(embeddedWallet.address),
        provider.getBalance(embeddedWallet.address),
      ]);
      
      setUsdcBalance(formatUnits(usdcBal, 6));
      setEthBalance(formatUnits(ethBal, 18));
    } catch (err) {
      console.error('Failed to fetch balances:', err);
    }
  }, [wallets]);

  // Auto-fetch balances when entering bridge step
  useEffect(() => {
    if (step === 'bridge' && wallets.length > 0) {
      fetchBalances();
    }
  }, [step, wallets, fetchBalances]);

  // Handle bridge button click
  const handleBridgeClick = useCallback(async () => {
    await fetchBalances();
    setStep('bridge');
  }, [fetchBalances]);

  // Handle bridge execution
  const handleBridge = useCallback(async () => {
    if (!bridgeAmount || wallets.length === 0) return;
    
    const amount = parseFloat(bridgeAmount);
    if (isNaN(amount) || amount < 5) {
      setError('Minimum bridge amount is 5 USDC');
      return;
    }

    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    if (!embeddedWallet) {
      setError('No wallet found');
      return;
    }

    setStep('bridging');
    setError(null);

    try {
      // Get the Ethereum provider from Privy wallet
      const provider = await embeddedWallet.getEthereumProvider();
      const ethersProvider = new ethers.BrowserProvider(provider);
      const signer = await ethersProvider.getSigner();

      // Switch to Arbitrum if needed
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0xa4b1' }], // Arbitrum One
        });
      } catch (switchError: any) {
        // Chain not added, try to add it
        if (switchError.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0xa4b1',
              chainName: 'Arbitrum One',
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://arb1.arbitrum.io/rpc'],
              blockExplorerUrls: ['https://arbiscan.io'],
            }],
          });
        }
      }

      const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);
      const amountWei = parseUnits(bridgeAmount, 6);

      // Check allowance
      const allowance = await usdc.allowance(embeddedWallet.address, HYPERLIQUID_BRIDGE);
      
      if (allowance < amountWei) {
        // Approve USDC spending
        const approveTx = await usdc.approve(HYPERLIQUID_BRIDGE, amountWei);
        await approveTx.wait();
      }

      // Transfer USDC to bridge
      const transferTx = await usdc.transfer(HYPERLIQUID_BRIDGE, amountWei);
      await transferTx.wait();

      setStep('bridged');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Bridge failed';
      setError(message);
      setStep('bridge');
    }
  }, [bridgeAmount, wallets]);

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

            <h2 className="text-xl font-semibold mb-2">
              {wantsReauth ? 'Re-authorize Agent' : 'Enable Trading'}
            </h2>
            <p className="text-zinc-400 text-sm mb-6">
              {wantsReauth 
                ? 'Sign to re-authorize your trading agent on Hyperliquid.'
                : 'Authorize the bot to trade on your behalf. You can revoke access anytime.'}
            </p>

            <div className="bg-zinc-800/50 rounded-lg p-3 mb-6 text-left">
              <p className="text-xs text-zinc-500 mb-1">Connected Wallet</p>
              <p className="text-sm font-mono text-zinc-300 truncate">
                {wallets[0]?.address}
              </p>
            </div>

            <button onClick={handleAuthorize} className="btn-gold w-full mb-3">
              Enable Trading
            </button>

            {/* Direct bridge option for already registered users */}
            <button 
              onClick={handleBridgeClick} 
              className="w-full bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 py-3 rounded-lg font-semibold text-sm transition border border-amber-600/30"
            >
              🌉 Already registered? Bridge USDC
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
            
            {registeredWallet && (
              <div className="bg-zinc-800/50 rounded-lg p-3 mb-4 text-left">
                <p className="text-xs text-zinc-500 mb-1">Your Trading Wallet</p>
                <p className="text-sm font-mono text-zinc-300 break-all">
                  {registeredWallet}
                </p>
              </div>
            )}

            {/* Onramp Selector */}
            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 mb-4 text-left">
              <p className="text-zinc-200 font-semibold text-sm mb-2">💳 Add Funds (USDC on Arbitrum)</p>
              <p className="text-xs text-zinc-400 mb-3">
                MoonPay via Privy. KYC may be required depending on your region.
              </p>

              <button
                onClick={handlePrivyFunding}
                disabled={isFunding}
                className="w-full block bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-600 disabled:cursor-not-allowed text-white py-2 px-4 rounded-lg font-semibold text-sm text-center transition"
              >
                {isFunding ? 'Opening MoonPay...' : '💳 Buy USDC with MoonPay'}
              </button>
            </div>

            <p className="text-zinc-400 text-sm mb-4">
              Once funded, trade xyz:GOLD in Telegram!
            </p>

            <button onClick={() => closeMiniApp()} className="btn-gold w-full">
              Return to Telegram
            </button>
          </div>
        )}

        {/* Onramp Step */}
        {step === 'onramp' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">💳</span>
            </div>
            <h2 className="text-xl font-semibold mb-2">Buy USDC</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Fund your wallet with USDC on Arbitrum using MoonPay. KYC may be required depending on your region.
            </p>

            {!authenticated ? (
              <div className="space-y-3">
                <p className="text-zinc-500 text-sm mb-4">
                  Please log in to fund your wallet.
                </p>
                <button
                  onClick={handleLogin}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 px-4 rounded-lg font-semibold transition"
                >
                  Log In
                </button>
              </div>
            ) : wallets.length === 0 ? (
              <div className="space-y-3">
                <p className="text-zinc-500 text-sm mb-4">
                  No wallet found. Please connect a wallet first.
                </p>
                <button
                  onClick={() => setStep('authorize')}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 px-4 rounded-lg font-semibold transition"
                >
                  Connect Wallet
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-zinc-800/50 rounded-lg p-3 mb-4 text-left">
                  <p className="text-xs text-zinc-500 mb-1">Wallet Address</p>
                  <p className="text-sm font-mono text-zinc-300 break-all">
                    {wallets.find((w) => w.walletClientType === 'privy')?.address || wallets[0]?.address}
                  </p>
                </div>

                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
                    <p className="text-red-400 text-sm">{error}</p>
                  </div>
                )}

                <button
                  onClick={handlePrivyFunding}
                  disabled={isFunding}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-600 disabled:cursor-not-allowed text-white py-3 px-4 rounded-lg font-semibold transition flex items-center justify-center gap-2"
                >
                  {isFunding ? (
                    <>
                      <div className="spinner w-4 h-4" />
                      Opening MoonPay...
                    </>
                  ) : (
                    '💳 Buy USDC with MoonPay'
                  )}
                </button>
              </div>
            )}

            <button 
              onClick={() => closeMiniApp()} 
              className="mt-4 w-full bg-zinc-700 hover:bg-zinc-600 text-white py-2 px-4 rounded-lg font-semibold text-sm transition"
            >
              Return to Telegram
            </button>
          </div>
        )}

        {/* Bridge Step */}
        {step === 'bridge' && (
          <div className="text-center">
            <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">🌉</span>
            </div>

            <h2 className="text-xl font-semibold mb-2">Bridge USDC</h2>
            <p className="text-zinc-400 text-sm mb-4">
              Send USDC from Arbitrum to Hyperliquid
            </p>

            {/* Balances */}
            <div className="bg-zinc-800/50 rounded-lg p-3 mb-4 text-left">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-zinc-500">USDC Balance</span>
                <span className="text-zinc-200 font-mono">{parseFloat(usdcBalance).toFixed(2)} USDC</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">ETH for Gas</span>
                <span className="text-zinc-200 font-mono">{parseFloat(ethBalance).toFixed(4)} ETH</span>
              </div>
            </div>

            {/* Amount Input */}
            <div className="mb-4">
              <label className="block text-xs text-zinc-500 mb-1 text-left">Amount to Bridge</label>
              <div className="relative">
                <input
                  type="number"
                  value={bridgeAmount}
                  onChange={(e) => setBridgeAmount(e.target.value)}
                  placeholder="100"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500"
                />
                <button
                  onClick={() => setBridgeAmount(usdcBalance)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-amber-400 hover:text-amber-300"
                >
                  MAX
                </button>
              </div>
              <p className="text-xs text-zinc-500 mt-1 text-left">Minimum: 5 USDC</p>
            </div>

            {error && (
              <p className="text-red-400 text-sm mb-4">{error}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => { setStep('success'); setError(null); }}
                className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-white py-3 rounded-lg font-semibold transition"
              >
                Back
              </button>
              <button
                onClick={handleBridge}
                disabled={!bridgeAmount || parseFloat(bridgeAmount) < 5}
                className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition"
              >
                Bridge
              </button>
            </div>
          </div>
        )}

        {/* Bridging Step */}
        {step === 'bridging' && (
          <div className="text-center py-8">
            <div className="spinner mx-auto mb-4" />
            <p className="text-zinc-400 mb-2">Bridging USDC...</p>
            <p className="text-xs text-zinc-500">Approve the transaction in your wallet</p>
          </div>
        )}

        {/* Bridged Success Step */}
        {step === 'bridged' && (
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

            <h2 className="text-xl font-semibold mb-2 text-green-500">Bridged!</h2>
            <p className="text-zinc-400 text-sm mb-2">
              {bridgeAmount} USDC sent to Hyperliquid
            </p>
            <p className="text-xs text-zinc-500 mb-6">
              Funds will appear in ~1 minute. You can start trading!
            </p>

            <button onClick={() => closeMiniApp()} className="btn-gold w-full">
              Return to Telegram
            </button>
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

