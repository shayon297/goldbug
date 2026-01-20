import type { Metadata, Viewport } from 'next';
import { PrivyProviderWrapper } from '@/lib/privy';
import './globals.css';

export const metadata: Metadata = {
  title: 'GOLD Trade - Connect Wallet',
  description: 'Trade GOLD with up to 20x leverage on Hyperliquid',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0a0a0a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </head>
      <body className="antialiased">
        <PrivyProviderWrapper>{children}</PrivyProviderWrapper>
      </body>
    </html>
  );
}

