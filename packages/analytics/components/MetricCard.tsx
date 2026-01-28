interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  icon?: string;
  className?: string;
}

export default function MetricCard({
  title,
  value,
  subtitle,
  trend,
  icon,
  className = '',
}: MetricCardProps) {
  return (
    <div className={`metric-card ${className}`}>
      <div className="flex items-start justify-between mb-2">
        <span className="text-zinc-500 text-xs uppercase tracking-wider">{title}</span>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl sm:text-3xl font-bold text-white">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {trend && (
          <span
            className={`text-sm font-medium ${
              trend.isPositive ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {trend.isPositive ? '+' : ''}{trend.value}%
          </span>
        )}
      </div>
      {subtitle && (
        <p className="mt-1 text-zinc-500 text-xs">{subtitle}</p>
      )}
    </div>
  );
}

