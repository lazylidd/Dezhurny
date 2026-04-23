export type Store = {
  id: number;
  name: string;
  display_name: string | null;
  platform: string | null;
  default_roi: number | null;
  tax_rate: number | null;
  early_ship_discount: number | null;
  selling_program: string | null;
  payout_frequency: string | null;
  stock_min: number | null;
  stock_max: number | null;
  auto_promo_sync: boolean | null;
  last_sync_at: string | null;
};
