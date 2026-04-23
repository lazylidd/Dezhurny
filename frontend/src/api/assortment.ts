import { apiFetch } from './client';
import type { Product } from '../types/product';
import { getStoreId } from './stores';

export async function fetchAssortment(storeNameOrId: string): Promise<Product[]> {
  return apiFetch<Product[]>(`/stores/${getStoreId(storeNameOrId)}/assortment?limit=500`);
}

export async function syncStore(storeNameOrId: string): Promise<{ synced: number }> {
  return apiFetch(`/stores/${getStoreId(storeNameOrId)}/sync`, { method: 'POST' });
}

export async function updateProduct(
  productId: number,
  data: { enabled?: boolean; roi?: number; stock?: number }
): Promise<Product> {
  const params = new URLSearchParams();
  if (data.enabled !== undefined) params.set('enabled', String(data.enabled));
  if (data.roi !== undefined) params.set('roi', String(data.roi));
  if (data.stock !== undefined) params.set('stock', String(data.stock));
  return apiFetch<Product>(`/products/${productId}?${params}`, { method: 'PATCH' });
}
