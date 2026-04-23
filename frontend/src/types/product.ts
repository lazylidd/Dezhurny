export type ProductStatus = 'active' | 'updated' | 'zeroed' | 'error';

export type Product = {
  id: number;
  store_id: number;
  sku: string;
  name: string | null;
  price: number | null;
  stock: number | null;
  category: string | null;
  category_id: string | null;
  commission: number | null;
  enabled: boolean;
  roi: number | null;
  status: ProductStatus | null;
  last_price_update: string | null;
  ym_availability: string | null;
  ym_processing_status: string | null;
  supplier_price: number | null;
  profit: number | null;
  actual_roi: number | null;
};
