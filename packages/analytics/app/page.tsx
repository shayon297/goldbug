import PasswordGate from '@/components/PasswordGate';
import Dashboard from '@/components/Dashboard';
import { fetchAllAnalytics } from '@/lib/api';

// Force dynamic rendering - no caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  // Fetch all analytics data on the server
  const data = await fetchAllAnalytics();

  return (
    <PasswordGate>
      <Dashboard
        overview={data.overview}
        userGrowth={data.userGrowth}
        retention={data.retention}
        funnel={data.funnel}
        engagement={data.engagement}
        trades={data.trades}
        error={data.error}
        timestamp={data.timestamp}
      />
    </PasswordGate>
  );
}
