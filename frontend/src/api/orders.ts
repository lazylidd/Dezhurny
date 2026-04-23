import type { Order, OrdersSummary, Receivables } from '../types/order';

const BASE = '/api';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...options, credentials: 'include' });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function syncOrders(storeId: number, dateFrom: string, dateTo: string): Promise<{ added: number }> {
  return apiFetch(`/stores/${storeId}/sync-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_from: dateFrom, date_to: dateTo }),
  });
}

export async function fetchOrders(
  storeId: number,
  params: { date_from?: string; date_to?: string; kind?: string; limit?: number; offset?: number },
): Promise<Order[]> {
  const qs = new URLSearchParams();
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  if (params.kind) qs.set('kind', params.kind);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return apiFetch(`/stores/${storeId}/orders?${qs}`);
}

export async function fetchOrdersSummary(
  storeId: number,
  dateFrom?: string,
  dateTo?: string,
): Promise<OrdersSummary> {
  const qs = new URLSearchParams();
  if (dateFrom) qs.set('date_from', dateFrom);
  if (dateTo) qs.set('date_to', dateTo);
  return apiFetch(`/stores/${storeId}/orders/summary?${qs}`);
}

export async function fetchReceivables(storeId: number): Promise<Receivables> {
  return apiFetch(`/stores/${storeId}/receivables`);
}

export async function syncActiveOrders(): Promise<{ synced: number; errors: string[] }> {
  return apiFetch('/orders/sync-active', { method: 'POST' });
}

export async function updateOrderSupplierPrice(
  storeId: number,
  orderDbId: number,
  supplierPrice: number | null,
): Promise<void> {
  await apiFetch(`/stores/${storeId}/orders/${orderDbId}/supplier-price`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplier_price: supplierPrice }),
  });
}

export async function updateOrderSerialNumber(
  storeId: number,
  orderDbId: number,
  serialNumber: string | null,
): Promise<void> {
  await apiFetch(`/stores/${storeId}/orders/${orderDbId}/serial-number`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial_number: serialNumber }),
  });
}
