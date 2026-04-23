import { apiFetch } from './client';

export interface StoreDashboard {
  id: number;
  name: string;
  total_products: number;
  enabled_products: number;
  zeroed_products: number;
  updated_today: number;
  revenue: number;
  fees: number;
  profit: number | null;
  roi: number | null;
  orders: number;
  nonpickup_count: number;
  return_count: number;
}

export interface CombinedStats {
  revenue: number;
  fees: number;
  tax_sum: number;
  profit: number | null;
  roi: number | null;
  orders: number;
  nonpickup_count: number;
  return_count: number;
  nonpickup_pct: number | null;
  return_pct: number | null;
  fees_actual_pct: number | null;
  avg_turnover: number | null;
}

export interface ChartPoint {
  date: string;
  revenue: number;
  fees: number;
  profit: number;
  count: number;
}

export interface DashboardData {
  stores: StoreDashboard[];
  combined: CombinedStats;
  chart: ChartPoint[];
}

export async function fetchDashboard(dateFrom?: string, dateTo?: string): Promise<DashboardData> {
  const qs = new URLSearchParams();
  if (dateFrom) qs.set('date_from', dateFrom);
  if (dateTo) qs.set('date_to', dateTo);
  const q = qs.toString();
  return apiFetch<DashboardData>(`/dashboard${q ? '?' + q : ''}`);
}
