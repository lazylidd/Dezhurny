import { apiFetch } from './client';

export interface AppSettings {
  auto_match_enabled: boolean;
  // Анти-аффилированность: авто-синхронизация
  sync_interval_min: number;
  sync_interval_max: number;
  sync_inter_store_delay_min: number;
  sync_inter_store_delay_max: number;
  sync_start_jitter_max: number;
  // Анти-аффилированность: применение цен
  price_stock_jitter_min: number;
  price_stock_jitter_max: number;
  apply_inter_store_delay_min: number;
  apply_inter_store_delay_max: number;
  [key: string]: unknown;
}

export function fetchSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings');
}

export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
