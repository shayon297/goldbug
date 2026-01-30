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
 * Generate chart image buffer (TradingView style)
 */
export async function generateChartBuffer(data: ChartData): Promise<Buffer> {
  const { candles, symbol, interval } = data;
  
  if (candles.length === 0) {
    throw new Error('No candle data available');
  }

  // Extract price data
  const closes = candles.map(c => parseFloat(c.c));
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  
  // Time labels - show HH:MM for intraday
  const labels = candles.map(c => {
    const date = new Date(c.t);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  });

  // Current price info
  const currentPrice = closes[closes.length - 1];
  const firstPrice = closes[0];
  const priceChange = currentPrice - firstPrice;
  const priceChangePercent = (priceChange / firstPrice) * 100;
  const isPositive = priceChange >= 0;

  // Calculate price range for y-axis
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  const padding = (maxPrice - minPrice) * 0.05;

  // TradingView-style chart config - clean and minimal
  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: symbol,
          data: closes,
          borderColor: isPositive ? '#26a69a' : '#ef5350', // TradingView green/red
          backgroundColor: isPositive 
            ? 'rgba(38, 166, 154, 0.08)' 
            : 'rgba(239, 83, 80, 0.08)',
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      layout: {
        padding: { top: 10, right: 20, bottom: 10, left: 10 },
      },
      plugins: {
        title: {
          display: true,
          text: `${symbol}  •  $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  ${isPositive ? '▲' : '▼'} ${Math.abs(priceChangePercent).toFixed(2)}%`,
          color: isPositive ? '#26a69a' : '#ef5350',
          font: { size: 16, weight: 'bold', family: 'Arial' },
          padding: { bottom: 20 },
          align: 'start',
        },
        legend: {
          display: false,
        },
        subtitle: {
          display: true,
          text: `${interval.toUpperCase()} • Last 4 Hours`,
          color: '#787b86',
          font: { size: 11, family: 'Arial' },
          padding: { bottom: 10 },
          align: 'start',
        },
      },
      scales: {
        x: {
          grid: { 
            color: '#2a2e39',
            drawBorder: false,
          },
          ticks: { 
            color: '#787b86', 
            maxTicksLimit: 8,
            font: { size: 10, family: 'Arial' },
          },
          border: { display: false },
        },
        y: {
          position: 'right',
          min: minPrice - padding,
          max: maxPrice + padding,
          grid: { 
            color: '#2a2e39',
            drawBorder: false,
          },
          ticks: { 
            color: '#787b86',
            font: { size: 10, family: 'Arial' },
            callback: (value: number) => `$${value.toFixed(2)}`,
          },
          border: { display: false },
        },
      },
    },
  };

  // Request chart image with TradingView dark theme background
  const response = await axios.post(
    QUICKCHART_URL,
    {
      chart: chartConfig,
      backgroundColor: '#131722', // TradingView dark background
      width: 800,
      height: 450,
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
  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const currentPrice = closes[closes.length - 1];
  const firstPrice = closes[0];
  
  // Calculate 4h change
  const change4h = ((currentPrice - firstPrice) / firstPrice) * 100;
  
  // High/Low in period
  const periodHigh = Math.max(...highs);
  const periodLow = Math.min(...lows);

  // Determine momentum
  let momentum = '→';
  if (change4h > 0.5) momentum = '↗️';
  else if (change4h > 0.1) momentum = '↑';
  else if (change4h < -0.5) momentum = '↘️';
  else if (change4h < -0.1) momentum = '↓';

  return `*${symbol}* • $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
    `${momentum} *4h:* ${change4h >= 0 ? '+' : ''}${change4h.toFixed(2)}%\n` +
    `📈 *High:* $${periodHigh.toFixed(2)}\n` +
    `📉 *Low:* $${periodLow.toFixed(2)}`;
}

