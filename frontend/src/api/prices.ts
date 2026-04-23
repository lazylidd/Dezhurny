import { apiFetch } from './client';
import type { PriceUpdate } from '../types/priceUpdate';

export function uploadPrices(
  entries: { file: File; supplier: string }[],
  onProgress?: (pct: number) => void,
): Promise<{ suppliers: string[]; rows: number; match_stats: { auto_confirmed: number; pending: number } }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    entries.forEach(({ file, supplier }) => {
      fd.append('files', file);
      fd.append('suppliers', supplier);
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload-prices');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        // 0–90%: реальный прогресс загрузки файла
        onProgress(Math.round((e.loaded / e.total) * 90));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Ошибка разбора ответа сервера'));
        }
      } else {
        reject(new Error(`Ошибка загрузки: ${xhr.responseText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Сетевая ошибка при загрузке'));
    xhr.send(fd);
  });
}

export async function fetchPriceUpdates(storeId?: number, sku?: string): Promise<PriceUpdate[]> {
  const params = new URLSearchParams();
  if (storeId != null) params.set('store_id', String(storeId));
  if (sku) params.set('sku', sku);
  const q = params.toString() ? `?${params}` : '';
  return apiFetch<PriceUpdate[]>(`/price-updates${q}`);
}

export async function confirmPriceUpdate(id: number): Promise<PriceUpdate> {
  return apiFetch<PriceUpdate>(`/price-updates/${id}/confirm`, { method: 'PATCH' });
}

export async function recalculateStore(
  storeId: number,
  onProgress: (done: number, total: number, apiCalls: number) => void,
  signal?: AbortSignal,
  force = false,
): Promise<{ calculated: number; no_match: number; errors: { sku: string; error: string }[]; api_calls: number }> {
  const response = await fetch(`/api/stores/${storeId}/recalculate?force=${force}`, { method: 'POST', signal, credentials: 'include' });
  if (!response.ok) throw new Error(`Ошибка: ${response.statusText}`);
  if (!response.body) throw new Error('Нет тела ответа');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (data.type === 'progress') {
        onProgress(data.done, data.total, data.api_calls);
      } else if (data.type === 'done') {
        return { calculated: data.calculated, no_match: data.no_match, errors: data.errors, api_calls: data.api_calls };
      } else if (data.type === 'error') {
        throw new Error(data.message);
      }
    }
  }
  throw new Error('Поток завершён неожиданно');
}

export async function fetchRecalcStatus(storeId: number): Promise<{
  status: 'idle' | 'running' | 'done' | 'error';
  done: number; total: number; api_calls: number;
  result: { calculated: number; no_match: number; errors: { sku: string; error: string }[]; api_calls: number } | null;
  error: string | null;
}> {
  return apiFetch(`/stores/${storeId}/recalculate/status`);
}

export async function stopRecalculate(storeId: number): Promise<void> {
  await apiFetch(`/stores/${storeId}/recalculate/stop`, { method: 'POST' });
}

export async function confirmAllPriceUpdates(): Promise<{ confirmed: number }> {
  return apiFetch('/price-updates/confirm-all', { method: 'POST' });
}

export type ApplyProgress =
  | { phase: 'starting' | 'applying_store'; current_store: string | null; applied: number }
  | { phase: 'waiting'; current_store: string | null; next_store: string | null; wait_remaining: number; wait_total: number; applied: number };

export async function applyPriceUpdates(
  onProgress: (p: ApplyProgress) => void,
  signal?: AbortSignal,
  storeId?: number,
  force = false,
): Promise<{ applied: number; errors: { sku: string; error: string }[] }> {
  const params = new URLSearchParams();
  if (storeId != null) params.set('store_id', String(storeId));
  if (force) params.set('force', 'true');
  const q = params.toString() ? `?${params}` : '';
  const response = await fetch(`/api/apply-price-updates${q}`, { method: 'POST', signal, credentials: 'include' });
  if (!response.ok) throw new Error(`Ошибка: ${response.statusText}`);
  if (!response.body) throw new Error('Нет тела ответа');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      if (data.type === 'progress') {
        onProgress(data as ApplyProgress);
      } else if (data.type === 'done') {
        return { applied: data.applied, errors: data.errors ?? [] };
      } else if (data.type === 'error') {
        throw new Error(data.message);
      }
    }
  }
  throw new Error('Поток завершён неожиданно');
}

export async function fetchApplyStatus(): Promise<{
  status: 'idle' | 'running' | 'done' | 'error';
  phase: string | null;
  current_store: string | null;
  next_store: string | null;
  applied: number;
  wait_remaining: number;
  wait_total: number;
  result: { applied: number; errors: { sku: string; error: string }[] } | null;
  error: string | null;
}> {
  return apiFetch('/apply-price-updates/status');
}

export async function stopApply(): Promise<void> {
  await apiFetch('/apply-price-updates/stop', { method: 'POST' });
}

export type PromoSyncEntry = {
  id: number;
  store_id: number;
  timestamp: string;
  sku: string;
  promo_id: string;
  promo_name: string | null;
  action: 'ADDED' | 'PRICE_UPDATED' | 'REMOVED' | 'SKIPPED';
  old_catalog_price: number | null;
  new_catalog_price: number | null;
  old_promo_price: number | null;
  new_promo_price: number | null;
  reason: string | null;
};

export async function fetchPromoSyncStats(storeId?: number): Promise<{ in_promo: number; in_promo_with_stock: number }> {
  const q = storeId !== undefined ? `?store_id=${storeId}` : '';
  return apiFetch(`/promo-sync-stats${q}`);
}

export async function fetchPromoSyncLog(storeId?: number): Promise<PromoSyncEntry[]> {
  const params = storeId !== undefined ? `?store_id=${storeId}&limit=200` : '?limit=200';
  return apiFetch(`/promo-sync-log${params}`);
}

export async function resetPriceUpdates(storeId?: number, days?: number): Promise<{ deleted: number }> {
  const p = new URLSearchParams();
  if (storeId !== undefined) p.set('store_id', String(storeId));
  if (days !== undefined) p.set('days', String(days));
  const q = p.toString() ? `?${p}` : '';
  return apiFetch(`/price-updates${q}`, { method: 'DELETE' });
}
