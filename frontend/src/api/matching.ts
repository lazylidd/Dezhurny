import { apiFetch } from './client';
import type { Candidate, MatchStats, MatchStatus, ProductMatch } from '../types/productMatch';

export async function fetchMatchingStats(supplier?: string): Promise<MatchStats> {
  const q = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
  return apiFetch<MatchStats>(`/matching/stats${q}`);
}

export async function fetchMatching(status?: MatchStatus, supplier?: string): Promise<ProductMatch[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (supplier) params.set('supplier', supplier);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch<ProductMatch[]>(`/matching${q}`);
}

export async function confirmMatch(
  id: number,
  sku: string,
  storeId: number,
): Promise<{ id: number; status: string; sku: string; product_name: string }> {
  return apiFetch(`/matching/${id}/confirm?sku=${encodeURIComponent(sku)}&store_id=${storeId}`, {
    method: 'POST',
  });
}

export async function stoplistMatch(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/stoplist`, { method: 'POST' });
}

export async function keepOldPrice(id: number, price?: number): Promise<{ id: number; status: string; supplier_price: number }> {
  const q = price != null ? `?price=${price}` : '';
  return apiFetch(`/matching/${id}/keep-price${q}`, { method: 'POST' });
}

export async function zeroStockMatch(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/zero-stock`, { method: 'POST' });
}

export async function resetMatch(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/reset`, { method: 'POST' });
}

export async function toggleAutoMatch(id: number): Promise<{ id: number; auto_match: boolean }> {
  return apiFetch(`/matching/${id}/toggle-auto`, { method: 'POST' });
}

export async function zeroAllNoPrice(): Promise<{ zeroed: number; errors: number }> {
  return apiFetch('/matching/zero-all-no-price', { method: 'POST' });
}

export async function restoreNoPrice(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/restore-no-price`, { method: 'POST' });
}

export async function fetchCandidates(id: number): Promise<Candidate[]> {
  return apiFetch<Candidate[]>(`/matching/${id}/candidates`);
}

export type SupplierSimilar = { name: string; normalized_name: string; price: number; score: number };

export async function fetchSupplierSimilar(id: number): Promise<SupplierSimilar[]> {
  return apiFetch<SupplierSimilar[]>(`/matching/${id}/supplier-similar`);
}

export async function rerunMatching(supplier?: string): Promise<{ suppliers: string[]; stats: Record<string, { auto_confirmed: number; pending: number; skipped: number }> }> {
  const q = supplier ? `?supplier=${encodeURIComponent(supplier)}` : '';
  return apiFetch(`/matching/rerun${q}`, { method: 'POST' });
}

export async function fetchSuppliers(): Promise<{ supplier: string; count: number }[]> {
  return apiFetch('/suppliers');
}

export async function approveAutoMatch(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/approve-auto`, { method: 'POST' });
}

export async function rejectAutoMatch(id: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/matching/${id}/reject-auto`, { method: 'POST' });
}

export async function fetchSettings(): Promise<{ auto_match_enabled: boolean }> {
  return apiFetch('/settings');
}

export async function updateSettings(data: { auto_match_enabled: boolean }): Promise<{ auto_match_enabled: boolean }> {
  return apiFetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

export async function deleteSupplier(supplier: string): Promise<{ supplier: string; prices_deleted: number; matches_deleted: number }> {
  return apiFetch(`/suppliers/${encodeURIComponent(supplier)}`, { method: 'DELETE' });
}

export type UnmatchedProduct = {
  store_id: number;
  sku: string;
  name: string | null;
  price: number | null;
  category: string | null;
};

export type SupplierCandidate = {
  match_id: number | null;
  supplier: string;
  supplier_name: string;
  supplier_normalized: string;
  supplier_price: number;
  score: number;
  match_status: string | null;
};

export async function fetchUnmatchedProducts(): Promise<UnmatchedProduct[]> {
  return apiFetch('/products/unmatched');
}

export async function fetchProductSupplierCandidates(storeId: number, sku: string): Promise<SupplierCandidate[]> {
  return apiFetch(`/products/${storeId}/${encodeURIComponent(sku)}/supplier-candidates`);
}

export async function confirmSupplierForProduct(
  storeId: number,
  sku: string,
  supplier: string,
  supplierNormalized: string,
): Promise<{ id: number; status: string; sku: string; store_id: number }> {
  const params = new URLSearchParams({ supplier, supplier_normalized: supplierNormalized });
  return apiFetch(`/products/${storeId}/${encodeURIComponent(sku)}/confirm-supplier?${params}`, { method: 'POST' });
}

export type ExportPendingItem = {
  supplier: string;
  supplier_name: string;
  supplier_price: number | null;
  candidates: { sku: string; store_id: number; product_name: string; score: number }[];
};

export type ExportUnmatchedSkuItem = {
  store: string;
  sku: string;
  name: string | null;
  price: number | null;
  candidates: { supplier: string; supplier_name: string; supplier_price: number | null; score: number }[];
};

export function fetchExportPending(): Promise<ExportPendingItem[]> {
  return apiFetch<ExportPendingItem[]>('/matching/export-pending');
}

export function fetchExportUnmatchedSkus(): Promise<ExportUnmatchedSkuItem[]> {
  return apiFetch<ExportUnmatchedSkuItem[]>('/matching/export-unmatched-skus');
}

export async function importSupplierMatches(file: File): Promise<{ updated: number; errors: string[] }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/matching/import-supplier-matches', {
    method: 'POST', body: form, credentials: 'include',
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Ошибка импорта'); }
  return res.json();
}

export async function importSkuMatches(file: File): Promise<{ updated: number; errors: string[] }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/matching/import-sku-matches', {
    method: 'POST', body: form, credentials: 'include',
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Ошибка импорта'); }
  return res.json();
}
