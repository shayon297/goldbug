import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://goldbug.app'),
  title: 'GoldBug - Trade Gold on Telegram',
  description: 'Trade tokenized gold with up to 20x leverage directly from Telegram. Powered by Hyperliquid.',
  keywords: ['gold trading', 'telegram trading bot', 'hyperliquid', 'leverage trading', 'crypto trading', 'gold perps'],
  authors: [{ name: 'GoldBug' }],
  openGraph: {
    title: 'GoldBug - Trade Gold on Telegram',
    description: 'Trade tokenized gold with up to 20x leverage directly from Telegram. Powered by Hyperliquid.',
    url: 'https://goldbug.app',
    siteName: 'GoldBug',
    type: 'website',
    locale: 'en_US',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'GoldBug - Trade Gold on Telegram',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GoldBug - Trade Gold on Telegram',
    description: 'Trade tokenized gold with up to 20x leverage directly from Telegram.',
    site: '@goldbug_app',
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0a0a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

