export type PriceUpdateStatus = 'calculated' | 'applied' | 'zeroed' | 'will_zero' | 'error';

export type TariffItem = { type: string; amount: number; pct?: number | null; [key: string]: unknown };

export type PriceUpdate = {
  id: number;
  store_id: number;
  sku: string;
  supplier: string | null;
  supplier_price: number | null;
  old_price: number | null;
  new_price: number;
  difference: number | null;
  difference_pct: number | null;
  profit: number | null;
  actual_roi: number | null;
  tariffs_json: string | null;
  old_stock: number | null;
  new_stock: number | null;
  requires_confirmation: boolean;
  status: PriceUpdateStatus;
  created_at: string | null;
};
