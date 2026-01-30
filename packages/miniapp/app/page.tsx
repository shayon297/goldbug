'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePrivy, useWallets, useFundWallet, useSendTransaction, useCreateWallet } from '@privy-io/react-auth';
import { Wallet, ethers, Contract, formatUnits, parseUnits } from 'ethers';
import { arbitrum } from 'viem/chains';
import {
  getTelegramUser,
  getTelegramInitData,
  closeMiniApp,
  expandMiniApp,
  openExternalLink,
} from '@/lib/telegram';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

// Builder fee configuration - address that receives trading fees
const BUILDER_ADDRESS = process.env.NEXT_PUBLIC_BUILDER_ADDRESS || '';

// Onramper widget configuration
const ONRAMPER_API_KEY = process.env.NEXT_PUBLIC_ONRAMPER_API_KEY || '';
const BUILDER_MAX_FEE_RATE = '0.1%'; // Maximum 0.1% for perps (10 bps)

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

type Step = 'init' | 'login' | 'authorize' | 'registering' | 'success' | 'bridge' | 'bridging' | 'bridged' | 'onramp' | 'offramp' | 'error';

export default function Home() {
  const privy = usePrivy();
  const { ready, authenticated, login, getAccessToken } = privy;
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { sendTransaction } = useSendTransaction();
  const { createWallet } = useCreateWallet();

  const [step, setStep] = useState<Step>('init');
  const [error, setError] = useState<string | null>(null);
  const [depositWarning, setDepositWarning] = useState<string | null>(null);
  const [builderFeeStatus, setBuilderFeeStatus] = useState<'pending' | 'approved' | 'failed' | null>(null);
  const [builderFeeError, setBuilderFeeError] = useState<string | null>(null);
  const [telegramUser, setTelegramUser] = useState<{ id: number; firstName: string } | null>(null);
  const [registeredWallet, setRegisteredWallet] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string>('0');
  const [bridgeAmount, setBridgeAmount] = useState<string>('');
  const [ethBalance, setEthBalance] = useState<string>('0');
  const [wantsBridge, setWantsBridge] = useState(false);
  const [wantsApproval, setWantsApproval] = useState(false);
  const [wantsBuilderFeeOnly, setWantsBuilderFeeOnly] = useState(false);
  const [wantsOnramp, setWantsOnramp] = useState(false);
  const [wantsOfframp, setWantsOfframp] = useState(false);
  const [wantsFunding, setWantsFunding] = useState(false);
  const [fundingAddress, setFundingAddress] = useState<string | null>(null);
  const checkedUrl = useRef(false);
  const fundingTriggered = useRef(false);

  const logClientEvent = useCallback(async (scope: string, message: string, data?: Record<string, unknown>) => {
    if (!API_URL) return;
    try {
      await fetch(`${API_URL}/api/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, message, data }),
      });
    } catch {
      // Ignore logging errors
    }
  }, []);

  // Initialize Telegram Web App and check URL params
  useEffect(() => {
    expandMiniApp();
    const user = getTelegramUser();
    setTelegramUser(user);

    // Check URL params or path for actions
    if (!checkedUrl.current) {
      checkedUrl.current = true;
      const params = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
      const actionFromPath = window.location.pathname.includes('/builderfee')
        ? 'builderfee'
        : window.location.pathname.includes('/approval')
          ? 'approval'
          : null;
      const action = actionFromPath || params.get('action') || hashParams.get('action');
      
      if (action === 'bridge') {
        console.log('[MiniApp] Bridge action detected');
        setWantsBridge(true);
      } else if (action === 'approval') {
        console.log('[MiniApp] Approval action detected');
        const version = params.get('v') || hashParams.get('v');
        if (!version) {
          setError('Please use the newest /approval button from the bot.');
          setStep('error');
          return;
        }
        setWantsApproval(true);
        void logClientEvent('approval', 'action_detected', { version });
      } else if (action === 'builderfee') {
        console.log('[MiniApp] Builder fee-only action detected');
        const version = params.get('v') || hashParams.get('v');
        if (!version) {
          setError('Please use the newest /builderfeeapproval button from the bot.');
          setStep('error');
          return;
        }
        setWantsBuilderFeeOnly(true);
        void logClientEvent('builder_fee', 'builder_fee_only_action_detected', { version });
      } else if (action === 'onramp') {
        console.log('[MiniApp] Onramp action detected');
        setWantsOnramp(true);
      } else if (action === 'offramp') {
        console.log('[MiniApp] Offramp action detected');
        setWantsOfframp(true);
      } else if (action === 'funding') {
        // Opened in external browser for funding
        console.log('[MiniApp] Funding action detected (external browser)');
        setWantsFunding(true);
        const addr = params.get('address') || hashParams.get('address');
        if (addr) setFundingAddress(addr);
      }
    }

    // Only show Telegram error if not in external browser for funding
    // action=funding is opened in external browser intentionally, so don't require Telegram
    const isExternalBrowser = !(window as any).Telegram?.WebApp;
    const isFundingAction = new URLSearchParams(window.location.search).get('action') === 'funding';
    
    if (!user && !isExternalBrowser && !isFundingAction) {
      setError('Please open this app from Telegram');
      setStep('error');
    }
    
    // If external browser funding, skip Telegram check entirely
    if (isExternalBrowser && isFundingAction) {
      console.log('[MiniApp] External browser funding mode - skipping Telegram check');
    }
  }, []);

  // Auto-create wallet if authenticated but no wallet exists
  // This is needed because automatic wallet creation may not work with seamless Telegram login
  const walletCreationAttempted = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (wallets.length > 0) return; // Already have a wallet
    if (walletCreationAttempted.current) return; // Already tried
    
    walletCreationAttempted.current = true;
    console.log('[MiniApp] Authenticated but no wallet - creating embedded wallet...');
    
    createWallet()
      .then((wallet) => {
        console.log('[MiniApp] Wallet created:', wallet.address);
      })
      .catch((err) => {
        console.error('[MiniApp] Failed to create wallet:', err);
        // Don't set error - may already have wallet, just not loaded yet
      });
  }, [ready, authenticated, wallets, createWallet]);

  // Update step based on Privy state
  useEffect(() => {
    if (!ready) return;
    // Don't reset these steps - they should persist until user action
    if (step === 'bridge' || step === 'bridging' || step === 'bridged' || step === 'onramp' || step === 'offramp' ||
        step === 'registering' || step === 'error' || step === 'success') return;

    if (authenticated && wallets.length > 0) {
      if (wantsFunding) {
        // External browser funding - stay on success/loading, let auto-trigger useEffect handle it
        console.log('[MiniApp] External browser funding mode - waiting for auto-trigger');
        // Don't change step - the other useEffect will trigger fundWallet
        return;
      } else if (wantsBridge) {
        console.log('[MiniApp] Going to bridge step');
        setStep('bridge');
      } else if (wantsOnramp) {
        console.log('[MiniApp] Going to onramp step');
        setStep('onramp');
      } else if (wantsOfframp) {
        console.log('[MiniApp] Going to offramp step');
        setStep('offramp');
      } else if (wantsApproval || wantsBuilderFeeOnly) {
        console.log('[MiniApp] Going to authorize step for approval');
        setStep('authorize');
      } else {
        setStep('authorize');
      }
    } else if (!authenticated) {
      // Go to login for any action
      setStep('login');
    }
  }, [ready, authenticated, wallets, wantsBridge, wantsApproval, wantsBuilderFeeOnly, wantsOnramp, wantsOfframp, wantsFunding, step]);

  // Auto-trigger funding when opened in external browser with funding action
  useEffect(() => {
    if (!ready || !authenticated || wallets.length === 0) return;
    if (!wantsFunding || fundingTriggered.current) return;
    if (!fundWallet) return;

    // We're in external browser with funding action - trigger Privy's fundWallet
    fundingTriggered.current = true;
    const address = fundingAddress || wallets.find((w) => w.walletClientType === 'privy')?.address || wallets[0]?.address;
    
    if (!address) return;

    console.log('[MiniApp] Auto-triggering Privy fundWallet for:', address);
    
    fundWallet({
      address,
      options: {
        chain: arbitrum,
        asset: 'USDC',
        amount: '10',
        defaultFundingMethod: 'card',
        card: {
          preferredProvider: 'moonpay',
        },
      },
    }).catch((err) => {
      console.error('[MiniApp] Auto-funding failed:', err);
    });
  }, [ready, authenticated, wallets, wantsFunding, fundingAddress, fundWallet]);

  // After success, fetch builder fee approval status for confirmation
  useEffect(() => {
    if (step !== 'success' || !registeredWallet || !API_URL) return;
    if (!BUILDER_ADDRESS || BUILDER_ADDRESS === '0x...your_builder_wallet_address' || BUILDER_ADDRESS === 'DISABLED') return;

    let cancelled = false;
    setBuilderFeeStatus('pending');
    setBuilderFeeError(null);

    const checkBuilderFeeStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/api/builder-fee-status?wallet=${registeredWallet}`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;

        if (data?.approved) {
          setBuilderFeeStatus('approved');
        } else {
          setBuilderFeeStatus('failed');
          if (data?.maxFeeRate !== undefined) {
            setBuilderFeeError(`Not approved yet (current: ${data.maxFeeRate})`);
          }
        }
      } catch (fetchError) {
        if (!cancelled) {
          setBuilderFeeStatus('failed');
          setBuilderFeeError('Unable to verify builder fee status.');
        }
      }
    };

    void checkBuilderFeeStatus();
    return () => {
      cancelled = true;
    };
  }, [step, registeredWallet]);

  // Handle login
  const handleLogin = useCallback(async () => {
    try {
      login();
    } catch (err) {
      setError('Login failed. Please try again.');
      setStep('error');
    }
  }, [login]);

  // Check if we're in an external browser (not Telegram WebView)
  const isExternalBrowser = typeof window !== 'undefined' && !(window as any).Telegram?.WebApp;

  // Open MoonPay via Privy - works in external browser, opens external for Telegram WebView
  const handleMoonPayFunding = useCallback(async () => {
    // Get embedded wallet address
    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    const address = embeddedWallet?.address || wallets[0]?.address;
    
    if (!address) {
      setError('No wallet address available. Please connect a wallet first.');
      setStep('error');
      return;
    }

    // If we're in Telegram WebView, open in external browser where Privy modal works
    if (!isExternalBrowser) {
      // Open Mini App in external browser with funding action
      const externalUrl = `${window.location.origin}?action=funding&address=${address}`;
      console.log('[MiniApp] Opening in external browser:', externalUrl);
      openExternalLink(externalUrl);
      return;
    }

    // We're in external browser - use Privy's fundWallet
    if (!fundWallet) {
      setError('Privy funding is not available. Please refresh the page.');
      setStep('error');
      return;
    }

    try {
      console.log('[MiniApp] Calling Privy fundWallet for:', address);
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
        },
      });
      console.log('[MiniApp] Funding completed');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[MiniApp] Funding failed:', err);
      setError(`Funding failed: ${errorMessage}`);
      setStep('error');
    }
  }, [wallets, fundWallet, isExternalBrowser]);

  // Handle agent authorization and registration
  const handleAuthorize = useCallback(async () => {
    if (!telegramUser || wallets.length === 0) return;

    setStep('registering');
    setError(null);
    setDepositWarning(null);
    setBuilderFeeStatus(null);
    setBuilderFeeError(null);

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
      
      let agentApproved = false;
      let needsDeposit = false;

      if (!wantsBuilderFeeOnly) {
        const hlResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        const hlResult = await hlResponse.json();
        console.log('[Hyperliquid] approveAgent result:', JSON.stringify(hlResult));
        await logClientEvent('approval', 'approve_agent_response', {
          walletAddress: embeddedWallet.address,
          response: hlResult,
        });

        // Check if approval succeeded or if user needs to deposit first
        if (hlResult.status === 'ok') {
          agentApproved = true;
          console.log('[Hyperliquid] Agent approved successfully:', agentAddress);
        } else {
          const errorMsg = hlResult.response || hlResult.error || JSON.stringify(hlResult);

          // Check if this is the "must deposit first" error - allow registration anyway
          if (errorMsg.includes('Must deposit before performing actions')) {
            console.log('[Hyperliquid] User needs to deposit first - proceeding with registration');
            needsDeposit = true;
            await logClientEvent('approval', 'needs_deposit', {
              walletAddress: embeddedWallet.address,
              reason: errorMsg,
            });
            // Don't throw - we'll register the user and they can /approval after depositing
          } else {
            throw new Error(`Agent approval failed: ${errorMsg}`);
          }
        }
      } else {
        console.log('[MiniApp] Skipping agent approval (builder fee only)');
      }

      // Approve builder fee if builder address is configured (always try, even if agent approval had issues)
      // This ensures users who already have an approved agent can still get builder fee approved
      const shouldApproveBuilderFee = BUILDER_ADDRESS &&
        BUILDER_ADDRESS !== '0x...your_builder_wallet_address' &&
        BUILDER_ADDRESS !== 'DISABLED' &&
        !needsDeposit; // Only skip if user has no funds

      console.log('[MiniApp] Builder fee approval check:', {
        BUILDER_ADDRESS,
        needsDeposit,
        wantsBuilderFeeOnly,
        shouldApproveBuilderFee,
      });

      if (shouldApproveBuilderFee) {
        setBuilderFeeStatus('pending');
        await logClientEvent('builder_fee', 'starting approval', {
          walletAddress: embeddedWallet.address,
          builder: BUILDER_ADDRESS,
        });

        try {
          const attemptApproval = async () => {
            const builderNonce = Date.now();
            // Match Python SDK: signatureChainId = 0x66eee (421614), domain chainId = 421614
            const SIGNATURE_CHAIN_ID = '0x66eee';
            const DOMAIN_CHAIN_ID = 421614; // parseInt('0x66eee', 16)
            
            const builderTypedData = {
              domain: {
                name: 'HyperliquidSignTransaction',
                version: '1',
                chainId: DOMAIN_CHAIN_ID,
                verifyingContract: '0x0000000000000000000000000000000000000000',
              },
              types: {
                'HyperliquidTransaction:ApproveBuilderFee': [
                  { name: 'hyperliquidChain', type: 'string' },
                  { name: 'maxFeeRate', type: 'string' },
                  { name: 'builder', type: 'address' },
                  { name: 'nonce', type: 'uint64' },
                ],
                EIP712Domain: [
                  { name: 'name', type: 'string' },
                  { name: 'version', type: 'string' },
                  { name: 'chainId', type: 'uint256' },
                  { name: 'verifyingContract', type: 'address' },
                ],
              },
              primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
              message: {
                hyperliquidChain: 'Mainnet',
                maxFeeRate: BUILDER_MAX_FEE_RATE,
                builder: BUILDER_ADDRESS.toLowerCase(),
                nonce: builderNonce,
              },
            };

            console.log('[MiniApp] Signing builder fee approval:', JSON.stringify(builderTypedData, null, 2));

            const builderSignature = await provider.request({
              method: 'eth_signTypedData_v4',
              params: [embeddedWallet.address, JSON.stringify(builderTypedData)],
            });

            const proxyResponse = await fetch(`${API_URL}/api/approve-builder-fee`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                walletAddress: embeddedWallet.address,
                signature: builderSignature,
                nonce: builderNonce,
              }),
            });

            const proxyResult = await proxyResponse.json();
            console.log('[MiniApp] approveBuilderFee proxy result:', JSON.stringify(proxyResult));
            await logClientEvent('builder_fee', 'proxy response', {
              status: proxyResponse.status,
              ok: proxyResponse.ok,
              response: proxyResult,
            });

            return { proxyResponse, proxyResult };
          };

          const attempt = await attemptApproval();

          const errorMsg =
            attempt.proxyResult?.response?.response ||
            attempt.proxyResult?.error ||
            'Builder fee approval failed';

          if (attempt.proxyResponse.ok && attempt.proxyResult?.response?.status === 'ok') {
            console.log('[Hyperliquid] Builder fee approved successfully');
            setBuilderFeeStatus('approved');
          } else {
            console.error('[Hyperliquid] Builder fee approval failed:', errorMsg);
            setBuilderFeeStatus('failed');
            setBuilderFeeError(errorMsg);
            if (typeof errorMsg === 'string' && errorMsg.includes('Must deposit before performing actions')) {
              const match = errorMsg.match(/User[:\s]+(0x[a-fA-F0-9]{40})/i) || 
                           errorMsg.match(/(0x[a-fA-F0-9]{40})/i);
              const addressForDeposit = match?.[1] || embeddedWallet.address;
              setDepositWarning(
                `Deposit USDC to ${addressForDeposit} on Hyperliquid, then run /approval to enable trading.`
              );
            }
            await logClientEvent('builder_fee', 'approval failed', { error: errorMsg });
          }
        } catch (builderError) {
          const message = builderError instanceof Error ? builderError.message : String(builderError);
          console.error('[MiniApp] Builder fee approval error:', message);
          setBuilderFeeStatus('failed');
          setBuilderFeeError(message);
          await logClientEvent('builder_fee', 'approval exception', { error: message });
        }
      } else if (needsDeposit) {
        console.log('[MiniApp] Skipping builder fee approval - user needs to deposit first');
        await logClientEvent('builder_fee', 'skipped_needs_deposit', {
          walletAddress: embeddedWallet.address,
        });
      } else {
        await logClientEvent('builder_fee', 'skipped_unknown', {
          walletAddress: embeddedWallet.address,
          reason: 'shouldApproveBuilderFee=false',
        });
      }

      // Get Privy access token
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Failed to get authentication token');
      }

      // Get Telegram init data for verification
      const initData = getTelegramInitData();

      if (!wantsBuilderFeeOnly) {
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
            agentApproved, // Tell backend if agent is approved on Hyperliquid
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Registration failed');
        }

        const data = await response.json();
        setRegisteredWallet(data.walletAddress || embeddedWallet.address);
      } else {
        setRegisteredWallet(embeddedWallet.address);
      }
      
      // If user needs to deposit first, show a different message
      if (needsDeposit) {
        setDepositWarning(
          `Wallet connected! Deposit USDC to ${embeddedWallet.address} on Hyperliquid, then use /approval to enable trading.`
        );
      } else if (agentApproved && !wantsBuilderFeeOnly) {
        // Notify backend that auth is complete - this will auto-execute any pending order
        try {
          await fetch(`${API_URL}/api/auth-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramUserId: telegramUser.id.toString() }),
          });
          console.log('[MiniApp] Notified backend of auth completion');
        } catch (notifyError) {
          console.warn('[MiniApp] Failed to notify auth completion:', notifyError);
          // Non-fatal - the order can be retried manually
        }
      }
      
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

  // Generate Onramper widget URL
  const getOnramperUrl = useCallback((mode: 'buy' | 'sell') => {
    const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
    const walletAddress = embeddedWallet?.address || wallets[0]?.address || '';
    
    const params = new URLSearchParams({
      apiKey: ONRAMPER_API_KEY,
      mode: mode,
      defaultCrypto: 'usdc_arbitrum',
      onlyCryptos: 'usdc_arbitrum',
      networkWallets: `arbitrum:${walletAddress}`,
      themeName: 'dark',
      containerColor: '18181bff', // zinc-900
      primaryColor: 'f59e0bff', // amber-500
      secondaryColor: '3f3f46ff', // zinc-700
      cardColor: '27272aff', // zinc-800
      primaryTextColor: 'faboraff', // white
      secondaryTextColor: 'a1a1aaff', // zinc-400
      borderRadius: '0.75', // rounded-lg
    });

    return `https://buy.onramper.com/?${params.toString()}`;
  }, [wallets]);

  // Handle bridge execution - tries gas sponsorship, falls back to gas drip
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
      const amountWei = parseUnits(bridgeAmount, 6);

      // Check current allowance using read-only provider
      const readProvider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
      const usdcRead = new Contract(USDC_ADDRESS, ERC20_ABI, readProvider);
      const currentAllowance = await usdcRead.allowance(embeddedWallet.address, HYPERLIQUID_BRIDGE);

      // Check if user has ETH for gas
      const ethBalance = await readProvider.getBalance(embeddedWallet.address);
      const needsGas = ethBalance < ethers.parseEther('0.00003');

      // Try gas sponsorship first, fall back to gas drip
      let useGasDrip = false;

      if (needsGas) {
        console.log('[Bridge] User needs gas, trying sponsorship first...');
        
        // Try Privy gas sponsorship
        try {
          const provider = await embeddedWallet.getEthereumProvider();
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0xa4b1' }],
          });

          const iface = new ethers.Interface(ERC20_ABI);
          const testData = iface.encodeFunctionData('approve', [HYPERLIQUID_BRIDGE, amountWei]);
          
          // Try a sponsored transaction
          await sendTransaction(
            { to: USDC_ADDRESS as `0x${string}`, data: testData as `0x${string}` },
            { sponsor: true }
          );
          console.log('[Bridge] Gas sponsorship worked!');
          
          // Wait for approval
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Now do the transfer
          const transferData = iface.encodeFunctionData('transfer', [HYPERLIQUID_BRIDGE, amountWei]);
          const result = await sendTransaction(
            { to: USDC_ADDRESS as `0x${string}`, data: transferData as `0x${string}` },
            { sponsor: true }
          );
          console.log('[Bridge] Transfer complete (sponsored), hash:', result.hash);
          
          setStep('bridged');
          return;
        } catch (sponsorError) {
          console.log('[Bridge] Gas sponsorship failed, falling back to gas drip:', sponsorError);
          useGasDrip = true;
        }
      }

      // Use gas drip if sponsorship failed or wasn't available
      if (useGasDrip || needsGas) {
        console.log('[Bridge] Using gas drip...');
        try {
          const dripResponse = await fetch(`${API_URL}/api/gas-drip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: embeddedWallet.address }),
          });
          
          const dripResult = await dripResponse.json();
          
          if (!dripResponse.ok) {
            throw new Error(dripResult.error || 'Gas drip failed');
          }
          
          if (dripResult.success && !dripResult.skipped) {
            console.log('[Bridge] Gas drip received:', dripResult.txHash);
            await new Promise(resolve => setTimeout(resolve, 4000));
          }
        } catch (dripError) {
          console.error('[Bridge] Gas drip failed:', dripError);
          setError('Unable to provide gas. Please add ~$0.10 ETH to your wallet on Arbitrum.');
          setStep('bridge');
          return;
        }
      }

      // Proceed with regular transaction (user now has gas)
      const provider = await embeddedWallet.getEthereumProvider();
      const ethersProvider = new ethers.BrowserProvider(provider);
      const signer = await ethersProvider.getSigner();

      // Switch to Arbitrum
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0xa4b1' }],
        });
      } catch (switchError: any) {
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

      // Approve if needed
      if (currentAllowance < amountWei) {
        console.log('[Bridge] Approving USDC...');
        const approveTx = await usdc.approve(HYPERLIQUID_BRIDGE, amountWei);
        await approveTx.wait();
        console.log('[Bridge] Approval complete');
      }

      // Transfer USDC to bridge
      console.log('[Bridge] Transferring USDC...');
      const transferTx = await usdc.transfer(HYPERLIQUID_BRIDGE, amountWei);
      await transferTx.wait();
      console.log('[Bridge] Transfer complete');

      setStep('bridged');
    } catch (err) {
      console.error('[Bridge] Error:', err);
      const message = err instanceof Error ? err.message : 'Bridge failed';
      setError(message);
      setStep('bridge');
    }
  }, [bridgeAmount, wallets, sendTransaction]);

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
              {wantsApproval ? 'Approve Trading' : 'Enable Trading'}
            </h2>
            <p className="text-zinc-400 text-sm mb-6">
              {wantsApproval 
                ? 'Sign to approve trading and builder fee on Hyperliquid.'
                : 'Authorize the bot to trade on your behalf. You can revoke access anytime.'}
              <span className="block mt-2 text-zinc-500">
                This must be the same wallet you funded on Hyperliquid.
              </span>
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

            {/* Show warning if user needs to deposit first */}
            {depositWarning && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4 text-left">
                <p className="text-amber-400 text-sm font-semibold mb-1">⚠️ Action Required</p>
                <p className="text-amber-300 text-xs">{depositWarning}</p>
              </div>
            )}

            {/* Builder fee approval status */}
            {builderFeeStatus && (
              <div className={`rounded-lg p-3 mb-4 text-left border ${
                builderFeeStatus === 'approved'
                  ? 'bg-green-500/10 border-green-500/30'
                  : builderFeeStatus === 'failed'
                    ? 'bg-red-500/10 border-red-500/30'
                    : 'bg-zinc-800/50 border-zinc-700/50'
              }`}>
                <p className={`text-sm font-semibold mb-1 ${
                  builderFeeStatus === 'approved' ? 'text-green-400' : builderFeeStatus === 'failed' ? 'text-red-400' : 'text-zinc-300'
                }`}>
                  {builderFeeStatus === 'approved'
                    ? '✅ Builder fee approved'
                    : builderFeeStatus === 'failed'
                      ? '❌ Builder fee not approved'
                      : '⏳ Checking builder fee approval'}
                </p>
                {builderFeeStatus === 'failed' && builderFeeError && (
                  <p className="text-xs text-red-300">
                    {builderFeeError}. Please run <strong>/approval</strong> again.
                  </p>
                )}
                {builderFeeStatus === 'pending' && (
                  <p className="text-xs text-zinc-400">Verifying approval status...</p>
                )}
              </div>
            )}

            {/* Funding Options */}
            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 mb-4 text-left">
              <p className="text-zinc-200 font-semibold text-sm mb-3">💰 Fund Your Account</p>
              
              <div className="space-y-2">
                <button
                  onClick={() => setStep('onramp')}
                  className="w-full bg-green-600 hover:bg-green-500 text-white py-2 px-4 rounded-lg font-semibold text-sm text-center transition flex items-center justify-center gap-2"
                >
                  💳 Buy USDC
                </button>
                
                <button
                  onClick={handleBridgeClick}
                  className="w-full bg-amber-600 hover:bg-amber-500 text-white py-2 px-4 rounded-lg font-semibold text-sm text-center transition flex items-center justify-center gap-2"
                >
                  🌉 Bridge from Arbitrum
                </button>
                
                <button
                  onClick={() => setStep('offramp')}
                  className="w-full bg-zinc-600 hover:bg-zinc-500 text-white py-2 px-4 rounded-lg font-semibold text-sm text-center transition flex items-center justify-center gap-2"
                >
                  🏦 Withdraw to Bank
                </button>
              </div>
            </div>

            <p className="text-zinc-400 text-sm mb-4">
              Once funded, trade xyz:GOLD in Telegram!
            </p>

            <button onClick={() => closeMiniApp()} className="btn-gold w-full">
              Return to Telegram
            </button>
          </div>
        )}

        {/* Onramp Step - Onramper Widget */}
        {step === 'onramp' && (
          <div className="text-center w-full">
            {!authenticated ? (
              <div className="space-y-3">
                <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">💳</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Buy USDC</h2>
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
                <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">💳</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Buy USDC</h2>
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
            ) : !ONRAMPER_API_KEY ? (
              <div className="space-y-3">
                <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">⚠️</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Configuration Required</h2>
                <p className="text-zinc-400 text-sm mb-4">
                  Onramper API key not configured. Please contact support.
                </p>
                <button 
                  onClick={() => closeMiniApp()} 
                  className="w-full bg-zinc-700 hover:bg-zinc-600 text-white py-2 px-4 rounded-lg font-semibold text-sm transition"
                >
                  Return to Telegram
                </button>
              </div>
            ) : (
              <div className="w-full -mx-6 -mb-6">
                <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
                  <h2 className="text-lg font-semibold">Buy USDC</h2>
                  <button 
                    onClick={() => closeMiniApp()} 
                    className="text-zinc-400 hover:text-white text-sm"
                  >
                    ✕ Close
                  </button>
                </div>
                <iframe
                  src={getOnramperUrl('buy')}
                  className="w-full border-0"
                  style={{ height: 'calc(100vh - 120px)', minHeight: '500px' }}
                  allow="accelerometer; autoplay; camera; gyroscope; payment"
                  title="Buy USDC with Onramper"
                />
              </div>
            )}
          </div>
        )}

        {/* Offramp Step - Onramper Sell Widget */}
        {step === 'offramp' && (
          <div className="text-center w-full">
            {!authenticated ? (
              <div className="space-y-3">
                <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">🏦</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Withdraw to Bank</h2>
                <p className="text-zinc-500 text-sm mb-4">
                  Please log in to withdraw funds.
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
                <div className="w-16 h-16 bg-gold-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">🏦</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Withdraw to Bank</h2>
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
            ) : !ONRAMPER_API_KEY ? (
              <div className="space-y-3">
                <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-3xl">⚠️</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Configuration Required</h2>
                <p className="text-zinc-400 text-sm mb-4">
                  Onramper API key not configured. Please contact support.
                </p>
                <button 
                  onClick={() => closeMiniApp()} 
                  className="w-full bg-zinc-700 hover:bg-zinc-600 text-white py-2 px-4 rounded-lg font-semibold text-sm transition"
                >
                  Return to Telegram
                </button>
              </div>
            ) : (
              <div className="w-full -mx-6 -mb-6">
                <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
                  <h2 className="text-lg font-semibold">Sell USDC</h2>
                  <button 
                    onClick={() => closeMiniApp()} 
                    className="text-zinc-400 hover:text-white text-sm"
                  >
                    ✕ Close
                  </button>
                </div>
                <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2">
                  <p className="text-amber-400 text-xs">
                    ⚠️ To sell, your USDC must be on Arbitrum. Withdraw from Hyperliquid first if needed.
                  </p>
                </div>
                <iframe
                  src={getOnramperUrl('sell')}
                  className="w-full border-0"
                  style={{ height: 'calc(100vh - 160px)', minHeight: '500px' }}
                  allow="accelerometer; autoplay; camera; gyroscope; payment"
                  title="Sell USDC with Onramper"
                />
              </div>
            )}
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

