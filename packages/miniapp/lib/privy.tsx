'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import { ReactNode } from 'react';
import { arbitrum } from 'viem/chains';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

export function PrivyProviderWrapper({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-500">
        Missing NEXT_PUBLIC_PRIVY_APP_ID
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#F59E0B',
          logo: undefined,
        },
        loginMethods: ['telegram', 'sms', 'email'],
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
        defaultChain: arbitrum,
      }}
    >
      {children}
    </PrivyProvider>
  );
}

