import { apiFetch } from './client';
import type { Store } from '../types/store';

export function getStoreId(storeNameOrId: string): number {
  const n = Number(storeNameOrId);
  if (!isNaN(n) && n > 0) return n;
  const MAP: Record<string, number> = { yam16: 1, yam21: 2 };
  const id = MAP[storeNameOrId];
  if (!id) throw new Error(`Unknown store: ${storeNameOrId}`);
  return id;
}

export async function fetchAllStores(): Promise<Store[]> {
  return apiFetch<Store[]>('/stores');
}

export async function fetchStore(storeNameOrId: string): Promise<Store> {
  return apiFetch<Store>(`/stores/${getStoreId(storeNameOrId)}`);
}

export type StoreStats = {
  total_products: number;
  enabled_products: number;
  zeroed_products: number;
  updated_today: number;
};

export async function fetchStoreStats(storeId: number): Promise<StoreStats> {
  return apiFetch<StoreStats>(`/stores/${storeId}/stats`);
}

export async function updateStore(
  storeNameOrId: string,
  data: Partial<Pick<Store, 'default_roi' | 'tax_rate' | 'early_ship_discount' | 'selling_program' | 'payout_frequency' | 'stock_min' | 'stock_max' | 'display_name' | 'auto_promo_sync'>>
): Promise<Store> {
  return apiFetch<Store>(`/stores/${getStoreId(storeNameOrId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function createStore(data: {
  display_name: string;
  name: string;
  api_key?: string;
  business_id?: string;
  campaign_ids?: string;
}): Promise<Store> {
  return apiFetch<Store>('/stores/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateStoreCredentials(
  storeId: number,
  data: { display_name?: string; name?: string; api_key?: string; business_id?: string; campaign_ids?: string }
): Promise<Store> {
  return apiFetch<Store>(`/stores/${storeId}/credentials`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteStore(storeId: number): Promise<void> {
  await apiFetch(`/stores/${storeId}`, { method: 'DELETE' });
}
