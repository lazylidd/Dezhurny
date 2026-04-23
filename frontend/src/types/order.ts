export type OrderKind = 'normal' | 'nonpickup' | 'return';

export interface FeeDetail {
  type: string;
  label: string;
  amount: number;
  pct: number;
}

export interface Order {
  id: number;
  store_id?: number;
  store_name?: string;
  order_id: string;
  offer_name: string | null;
  sku: string | null;
  order_kind: OrderKind;
  order_date: string | null;  // ISO date
  market_price: number | null;
  buyer_payment: number | null;
  revenue: number | null;  // buyer_payment + subsidies
  all_services_fee: number | null;
  fees_total?: number;
  fee_details?: FeeDetail[];
  is_forecast?: boolean;
  supplier_price: number | null;
  supplier_price_matched?: number | null;
  supplier_price_is_manual: boolean;
  commission_amount: number | null;
  promo_discount: number | null;
  tax_amount: number | null;
  profit: number | null;
  ros?: number | null;
  roi?: number | null;
  margin_pct: number | null;
}

export interface DailyStats {
  date: string;
  revenue: number;
  fees: number;
  supplier: number;
  profit: number;
  count: number;
}

export interface OrdersSummary {
  total_orders: number;
  matched_orders: number;
  total_revenue: number;
  total_fees: number;
  total_tax: number;
  total_supplier_cost: number | null;
  total_profit: number | null;
  roi: number | null;
  nonpickup_count: number;
  return_count: number;
  nonpickup_pct: number | null;
  return_pct: number | null;
  daily: DailyStats[];
}

export interface Receivables {
  total: number;
  adjusted: number;
  nonpickup_pct: number;
  return_pct: number;
}
