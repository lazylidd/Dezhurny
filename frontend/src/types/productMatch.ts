export type MatchStatus = 'pending' | 'confirmed' | 'stoplist' | 'no_price' | 'awaiting_price' | 'auto_review';

export type Candidate = {
  sku: string;
  store_id: number;
  product_name: string;
  score: number;
  match_by?: string;
};

export type ProductMatch = {
  id: number;
  supplier: string;
  supplier_name: string;
  supplier_normalized: string;
  supplier_price: number | null;
  sku: string | null;
  store_id: number | null;
  product_name: string | null;
  status: MatchStatus;
  match_type: 'auto' | 'manual' | 'exact' | null;
  best_score: number | null;
  created_at: string | null;
  price_is_current?: boolean;
  auto_match?: boolean;
  confirmed_at?: string | null;
};

export type MatchStats = {
  pending: number;
  confirmed: number;
  stoplist: number;
  no_price: number;
  auto_review: number;
};
