'use client';

import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

const GOLD_COLOR = '#F59E0B';
const GOLD_GRADIENT = ['#FCD34D', '#F59E0B', '#B45309'];
const CHART_COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#6366F1'];

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color?: string }>;
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: ChartTooltipProps) => {
  if (!active || !payload?.length) return null;
  
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 shadow-lg">
      <p className="text-zinc-400 text-xs mb-1">{label}</p>
      {payload.map((entry, idx) => (
        <p key={idx} className="text-white text-sm font-medium">
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
        </p>
      ))}
    </div>
  );
};

interface UserGrowthChartProps {
  data: Array<{ date: string; newUsers: number; totalUsers: number }>;
}

export function UserGrowthChart({ data }: UserGrowthChartProps) {
  const formattedData = data.map(d => ({
    ...d,
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <div className="chart-container">
      <h3 className="text-lg font-semibold text-white mb-4">User Growth</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={formattedData}>
            <defs>
              <linearGradient id="userGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GOLD_COLOR} stopOpacity={0.3} />
                <stop offset="100%" stopColor={GOLD_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="totalUsers"
              name="Total Users"
              stroke={GOLD_COLOR}
              fill="url(#userGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface EngagementChartProps {
  data: Array<{ date: string; dau: number }>;
}

export function EngagementChart({ data }: EngagementChartProps) {
  const formattedData = data.map(d => ({
    ...d,
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <div className="chart-container">
      <h3 className="text-lg font-semibold text-white mb-4">Daily Active Users</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={formattedData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="dau" name="DAU" fill={GOLD_COLOR} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface VolumeChartProps {
  data: Array<{ date: string; volume: number }>;
}

export function VolumeChart({ data }: VolumeChartProps) {
  const formattedData = data.map(d => ({
    ...d,
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  return (
    <div className="chart-container">
      <h3 className="text-lg font-semibold text-white mb-4">Trading Volume (USD)</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={formattedData}>
            <defs>
              <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10B981" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis 
              tick={{ fill: '#71717a', fontSize: 11 }} 
              axisLine={false} 
              tickLine={false}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="volume"
              name="Volume"
              stroke="#10B981"
              fill="url(#volumeGradient)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface FunnelChartProps {
  funnel: {
    signups: number;
    walletConnected: number;
    agentApproved: number;
    firstTrade: number;
  };
}

export function FunnelChart({ funnel }: FunnelChartProps) {
  const maxValue = Math.max(funnel.signups, 1);
  
  const steps = [
    { label: 'Signups', value: funnel.signups, percentage: 100 },
    { label: 'Wallet Connected', value: funnel.walletConnected, percentage: (funnel.walletConnected / maxValue) * 100 },
    { label: 'Agent Approved', value: funnel.agentApproved, percentage: (funnel.agentApproved / maxValue) * 100 },
    { label: 'First Trade', value: funnel.firstTrade, percentage: (funnel.firstTrade / maxValue) * 100 },
  ];

  return (
    <div className="chart-container">
      <h3 className="text-lg font-semibold text-white mb-4">Conversion Funnel</h3>
      <div className="space-y-4">
        {steps.map((step, idx) => (
          <div key={step.label} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">{step.label}</span>
              <span className="text-white font-medium">{step.value.toLocaleString()}</span>
            </div>
            <div className="h-8 bg-zinc-800 rounded overflow-hidden">
              <div
                className="funnel-bar"
                style={{ 
                  width: `${Math.max(step.percentage, 2)}%`,
                  opacity: 1 - (idx * 0.15),
                }}
              />
            </div>
            {idx < steps.length - 1 && (
              <div className="text-xs text-zinc-500 text-right">
                {steps[idx + 1].value > 0 
                  ? `${((steps[idx + 1].value / step.value) * 100).toFixed(1)}% converted`
                  : '0% converted'
                }
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface LeverageDistributionProps {
  distribution: Record<number, number>;
}

export function LeverageDistributionChart({ distribution }: LeverageDistributionProps) {
  const data = Object.entries(distribution)
    .map(([leverage, count]) => ({
      name: `${leverage}x`,
      value: count,
    }))
    .sort((a, b) => parseInt(a.name) - parseInt(b.name));

  return (
    <div className="chart-container">
      <h3 className="text-lg font-semibold text-white mb-4">Leverage Distribution</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
              labelLine={false}
            >
              {data.map((entry, index) => (
                <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface RetentionTableProps {
  cohorts: Array<{
    cohortWeek: string;
    cohortSize: number;
    retention: number[];
  }>;
}

export function RetentionTable({ cohorts }: RetentionTableProps) {
  const maxWeeks = Math.max(...cohorts.map(c => c.retention.length), 0);
  
  return (
    <div className="chart-container overflow-x-auto">
      <h3 className="text-lg font-semibold text-white mb-4">Cohort Retention</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-xs uppercase">
            <th className="text-left py-2 pr-4">Cohort</th>
            <th className="text-right py-2 px-2">Size</th>
            {Array.from({ length: maxWeeks }).map((_, i) => (
              <th key={i} className="text-right py-2 px-2">Week {i}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.cohortWeek} className="border-t border-zinc-800">
              <td className="py-2 pr-4 text-zinc-400">
                {new Date(cohort.cohortWeek).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </td>
              <td className="py-2 px-2 text-right text-white">{cohort.cohortSize}</td>
              {cohort.retention.map((rate, i) => (
                <td key={i} className="py-2 px-2 text-right">
                  <span
                    className="inline-block px-2 py-0.5 rounded text-xs font-medium"
                    style={{
                      backgroundColor: `rgba(245, 158, 11, ${rate / 100})`,
                      color: rate > 50 ? '#000' : '#fff',
                    }}
                  >
                    {rate}%
                  </span>
                </td>
              ))}
              {/* Fill empty cells */}
              {Array.from({ length: maxWeeks - cohort.retention.length }).map((_, i) => (
                <td key={`empty-${i}`} className="py-2 px-2" />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {cohorts.length === 0 && (
        <p className="text-zinc-500 text-center py-8">No cohort data yet</p>
      )}
    </div>
  );
}

