const TTL_MS = 5 * 60 * 1000; // 5 минут

type CacheEntry = { data: unknown; savedAt: number };
const cache = new Map<string, CacheEntry>();

export function saveCache<T = unknown>(key: string, data: T): void {
  cache.set(key, { data, savedAt: Date.now() });
}

export function loadCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TTL_MS) { cache.delete(key); return null; }
  return entry.data as T;
}

export function clearCache(...keys: string[]): void {
  keys.forEach((k) => cache.delete(k));
}

// Ключи кэша страниц
export const CACHE_KEYS = {
  matching: 'matching_page',
  uploadPrices: 'upload_prices_page',
  store: (id: string) => `store_page_${id}`,
};
