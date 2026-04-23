import { apiFetch } from './client';

export interface FeeDetail {
  type: string;
  label: string;
  amount: number;
  pct: number;
}

export interface AssemblyItem {
  order_id: string;
  status: string;
  campaign_id: number;
  sku: string;
  offer_name: string;
  count: number;
  buyer_price: number;
  total_buyer: number;
  supplier_price: number | null;
  total_supplier: number | null;
  fees: number;
  fee_details: FeeDetail[];
  fee_source: string;
  profit: number | null;
  roi: number | null;
  ros: number | null;
}

export interface AssemblyStore {
  store_id: number;
  store_name: string;
  campaign_ids: number[];
  orders: AssemblyItem[];
}

export interface Shipment {
  id: string | number;
  status: string;
  campaign_id: number;
  planIntervalFrom?: string;
  planIntervalTo?: string;
  warehouseId?: number;
  warehouse?: { name?: string; address?: { street?: string } };
  ordersCount?: number;
}

export interface AssemblyResponse {
  before_cutoff: boolean;
  cutoff_time: string;
  stores: AssemblyStore[];
}

export async function fetchAssembly(): Promise<AssemblyResponse> {
  return apiFetch('/assembly');
}

export async function fetchAssemblyShipments(storeId: number): Promise<Shipment[]> {
  return apiFetch(`/stores/${storeId}/assembly/shipments`);
}

export function labelsUrl(storeId: number, campaignId: number, orderIds: string[]): string {
  return `/api/stores/${storeId}/assembly/labels?campaign_id=${campaignId}&order_ids=${orderIds.join(',')}`;
}

export function sheetUrl(storeId: number, campaignId: number): string {
  return `/api/stores/${storeId}/assembly/sheet?campaign_id=${campaignId}`;
}

export function actUrl(storeId: number, campaignId: number, shipmentId: string | number): string {
  return `/api/stores/${storeId}/assembly/act?campaign_id=${campaignId}&shipment_id=${shipmentId}`;
}

export function shipmentListUrl(storeId: number, campaignId: number, orderIds: string[], shipmentId?: string | number): string {
  let url = `/api/stores/${storeId}/assembly/shipment-list?campaign_id=${campaignId}`;
  if (shipmentId != null) url += `&shipment_id=${shipmentId}`;
  else url += `&order_ids=${orderIds.join(',')}`;
  return url;
}

export interface CampaignLabelsRequest {
  campaign_id: number;
  order_ids: string[];
}

export interface CampaignDocRequest {
  campaign_id: number;
  order_ids: string[];
  shipment_id?: number;
}

export interface StoreDocRequest {
  store_id: number;
  store_name: string;
  campaigns: CampaignDocRequest[];
}

function extractFilename(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') || '';
  const rfc = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (rfc) return decodeURIComponent(rfc[1]);
  const plain = cd.match(/filename="([^"]+)"/);
  return plain ? plain[1] : fallback;
}

export async function fetchDownload(url: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ошибка ${res.status}: ${text.slice(0, 200)}`);
  }
  return { blob: await res.blob(), filename: extractFilename(res, 'download') };
}

export async function downloadAllLabels(storeId: number, campaigns: CampaignLabelsRequest[]): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`/api/stores/${storeId}/assembly/all-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(campaigns),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ошибка ${res.status}: ${text.slice(0, 200)}`);
  }
  return { blob: await res.blob(), filename: extractFilename(res, 'ярлыки.pdf') };
}

export async function downloadAllDocuments(stores: StoreDocRequest[]): Promise<Blob> {
  const res = await fetch('/api/assembly/all-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stores),
  });
  if (!res.ok) throw new Error(`Ошибка ${res.status}: ${await res.text()}`);
  return res.blob();
}

export async function markOrdersReady(storeId: number, campaignId: number, orderIds: string[]): Promise<{ results: { order_id: string; ok: boolean; error?: string }[] }> {
  return apiFetch(`/stores/${storeId}/assembly/ready?campaign_id=${campaignId}&order_ids=${orderIds.join(',')}`, { method: 'POST' });
}
