import axios from 'axios';
import type { Candle } from '../hyperliquid/types.js';

const QUICKCHART_URL = 'https://quickchart.io/chart';

interface ChartData {
  candles: Candle[];
  symbol: string;
  interval: string;
}

/**
 * Calculate Simple Moving Average
 */
function calculateSMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
  }
  return result;
}

/**
 * Calculate Exponential Moving Average
 */
function calculateEMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const multiplier = 2 / (period + 1);
  
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      // First EMA is SMA
      const sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    } else {
      const prev = result[i - 1] as number;
      result.push((prices[i] - prev) * multiplier + prev);
    }
  }
  return result;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(prices: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  result.push(null); // First price has no RSI

  for (let i = 0; i < gains.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const avgGain = gains.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
      
      if (avgLoss === 0) {
        result.push(100);
      } else {
        const rs = avgGain / avgLoss;
        result.push(100 - (100 / (1 + rs)));
      }
    }
  }

  return result;
}

/**
 * Find support and resistance levels
 */
function findSupportResistance(candles: Candle[], lookback: number = 20): { support: number; resistance: number } {
  const recentCandles = candles.slice(-lookback);
  const highs = recentCandles.map(c => parseFloat(c.h));
  const lows = recentCandles.map(c => parseFloat(c.l));
  
  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs),
  };
}

/**
 * Generate a trading chart image URL
 */
export async function generateChartUrl(data: ChartData): Promise<string> {
  const { candles, symbol, interval } = data;
  
  if (candles.length === 0) {
    throw new Error('No candle data available');
  }

  // Extract price data
  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const labels = candles.map(c => {
    const date = new Date(c.t);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Calculate indicators
  const sma20 = calculateSMA(closes, 20);
  const ema9 = calculateEMA(closes, 9);
  const rsi = calculateRSI(closes, 14);
  const { support, resistance } = findSupportResistance(candles);

  // Current price info
  const currentPrice = closes[closes.length - 1];
  const priceChange = closes.length > 1 ? currentPrice - closes[closes.length - 2] : 0;
  const priceChangePercent = closes.length > 1 ? (priceChange / closes[closes.length - 2]) * 100 : 0;
  const currentRSI = rsi[rsi.length - 1];

  // Build chart configuration
  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${symbol} Price`,
          data: closes,
          borderColor: '#FFD700',
          backgroundColor: 'rgba(255, 215, 0, 0.1)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.1,
        },
        {
          label: 'SMA 20',
          data: sma20,
          borderColor: '#3B82F6',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          borderDash: [5, 5],
        },
        {
          label: 'EMA 9',
          data: ema9,
          borderColor: '#10B981',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Support',
          data: Array(closes.length).fill(support),
          borderColor: '#EF4444',
          borderWidth: 1,
          pointRadius: 0,
          borderDash: [10, 5],
          fill: false,
        },
        {
          label: 'Resistance',
          data: Array(closes.length).fill(resistance),
          borderColor: '#22C55E',
          borderWidth: 1,
          pointRadius: 0,
          borderDash: [10, 5],
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: [
            `${symbol} ${interval} Chart`,
            `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${priceChange >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%)`,
            `RSI: ${currentRSI?.toFixed(1) || 'N/A'} | S: $${support.toFixed(2)} | R: $${resistance.toFixed(2)}`,
          ],
          color: '#FFFFFF',
          font: { size: 14 },
        },
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: '#CCCCCC', font: { size: 10 } },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.1)' },
          ticks: { color: '#CCCCCC', maxTicksLimit: 10 },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.1)' },
          ticks: { 
            color: '#CCCCCC',
            callback: (value: number) => `$${value.toLocaleString()}`,
          },
        },
      },
    },
  };

  // Generate chart URL
  const chartUrl = `${QUICKCHART_URL}?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=%231a1a2e&width=800&height=500&format=png`;

  return chartUrl;
}

/**
 * Generate chart image buffer (for sending via Telegram)
 */
export async function generateChartBuffer(data: ChartData): Promise<Buffer> {
  const { candles, symbol, interval } = data;
  
  if (candles.length === 0) {
    throw new Error('No candle data available');
  }

  // Extract price data
  const closes = candles.map(c => parseFloat(c.c));
  const labels = candles.map(c => {
    const date = new Date(c.t);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Calculate indicators
  const sma20 = calculateSMA(closes, 20);
  const ema9 = calculateEMA(closes, 9);
  const rsi = calculateRSI(closes, 14);
  const { support, resistance } = findSupportResistance(candles);

  // Current price info
  const currentPrice = closes[closes.length - 1];
  const priceChange = closes.length > 1 ? currentPrice - closes[closes.length - 2] : 0;
  const priceChangePercent = closes.length > 1 ? (priceChange / closes[closes.length - 2]) * 100 : 0;
  const currentRSI = rsi[rsi.length - 1];

  // Determine trend
  const ema9Current = ema9[ema9.length - 1];
  const sma20Current = sma20[sma20.length - 1];
  let trendSignal = '⚪ Neutral';
  if (ema9Current && sma20Current) {
    if (ema9Current > sma20Current && currentPrice > ema9Current) {
      trendSignal = '🟢 Bullish';
    } else if (ema9Current < sma20Current && currentPrice < ema9Current) {
      trendSignal = '🔴 Bearish';
    }
  }

  // RSI signal
  let rsiSignal = '';
  if (currentRSI !== null) {
    if (currentRSI > 70) rsiSignal = ' (Overbought)';
    else if (currentRSI < 30) rsiSignal = ' (Oversold)';
  }

  // Build chart configuration
  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${symbol}`,
          data: closes,
          borderColor: '#FFD700',
          backgroundColor: 'rgba(255, 215, 0, 0.15)',
          borderWidth: 2.5,
          fill: true,
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: 'SMA 20',
          data: sma20,
          borderColor: '#60A5FA',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          borderDash: [5, 5],
        },
        {
          label: 'EMA 9',
          data: ema9,
          borderColor: '#34D399',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Support',
          data: Array(closes.length).fill(support),
          borderColor: 'rgba(239, 68, 68, 0.7)',
          borderWidth: 1,
          pointRadius: 0,
          borderDash: [8, 4],
          fill: false,
        },
        {
          label: 'Resistance',
          data: Array(closes.length).fill(resistance),
          borderColor: 'rgba(34, 197, 94, 0.7)',
          borderWidth: 1,
          pointRadius: 0,
          borderDash: [8, 4],
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: [
            `${symbol} | ${interval} Chart | ${trendSignal}`,
            `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${priceChange >= 0 ? '+' : ''}${priceChangePercent.toFixed(2)}%)`,
            `RSI: ${currentRSI?.toFixed(1) || 'N/A'}${rsiSignal} | Support: $${support.toFixed(0)} | Resistance: $${resistance.toFixed(0)}`,
          ],
          color: '#FFFFFF',
          font: { size: 13, weight: 'bold' },
          padding: { bottom: 15 },
        },
        legend: {
          display: true,
          position: 'bottom',
          labels: { 
            color: '#AAAAAA', 
            font: { size: 10 },
            boxWidth: 15,
            padding: 15,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { 
            color: '#888888', 
            maxTicksLimit: 8,
            font: { size: 10 },
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { 
            color: '#888888',
            font: { size: 10 },
            callback: (value: number) => `$${value.toLocaleString()}`,
          },
        },
      },
    },
  };

  // Request chart image
  const response = await axios.post(
    QUICKCHART_URL,
    {
      chart: chartConfig,
      backgroundColor: '#0f0f23',
      width: 800,
      height: 500,
      format: 'png',
    },
    {
      responseType: 'arraybuffer',
      timeout: 15000,
    }
  );

  return Buffer.from(response.data);
}

/**
 * Generate chart summary text (for caption)
 */
export function generateChartSummary(candles: Candle[], symbol: string): string {
  if (candles.length === 0) return 'No data available';

  const closes = candles.map(c => parseFloat(c.c));
  const currentPrice = closes[closes.length - 1];
  
  // Calculate changes
  const change24h = closes.length > 6 ? ((currentPrice - closes[closes.length - 7]) / closes[closes.length - 7]) * 100 : 0;
  const change7d = closes.length > 42 ? ((currentPrice - closes[closes.length - 43]) / closes[closes.length - 43]) * 100 : 0;

  // Calculate indicators
  const rsi = calculateRSI(closes, 14);
  const currentRSI = rsi[rsi.length - 1];
  const ema9 = calculateEMA(closes, 9);
  const sma20 = calculateSMA(closes, 20);
  const { support, resistance } = findSupportResistance(candles);

  // Trend analysis
  const ema9Current = ema9[ema9.length - 1];
  const sma20Current = sma20[sma20.length - 1];
  let trend = '⚪ Neutral';
  let trendDesc = 'Price is consolidating';
  
  if (ema9Current && sma20Current) {
    if (ema9Current > sma20Current && currentPrice > ema9Current) {
      trend = '🟢 Bullish';
      trendDesc = 'EMA9 > SMA20, price above both';
    } else if (ema9Current < sma20Current && currentPrice < ema9Current) {
      trend = '🔴 Bearish';
      trendDesc = 'EMA9 < SMA20, price below both';
    }
  }

  // RSI analysis
  let rsiStatus = 'Neutral zone';
  if (currentRSI !== null) {
    if (currentRSI > 70) rsiStatus = '⚠️ Overbought';
    else if (currentRSI > 60) rsiStatus = 'Strong';
    else if (currentRSI < 30) rsiStatus = '⚠️ Oversold';
    else if (currentRSI < 40) rsiStatus = 'Weak';
  }

  return `📊 *${symbol} Analysis*\n\n` +
    `💵 *Price:* $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
    `📈 *24h:* ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%\n` +
    `📅 *7d:* ${change7d >= 0 ? '+' : ''}${change7d.toFixed(2)}%\n\n` +
    `*Technical Indicators:*\n` +
    `• Trend: ${trend}\n` +
    `• RSI(14): ${currentRSI?.toFixed(1) || 'N/A'} - ${rsiStatus}\n` +
    `• Support: $${support.toFixed(2)}\n` +
    `• Resistance: $${resistance.toFixed(2)}\n\n` +
    `_${trendDesc}_`;
}

