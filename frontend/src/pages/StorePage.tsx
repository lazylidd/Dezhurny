import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import LoadingCats from '../components/ui/LoadingCats';
import { CACHE_KEYS, clearCache, loadCache, saveCache } from '../utils/pageCache';
import { fetchAssortment, syncStore } from '../api/assortment';
import { fetchStore, updateStore } from '../api/stores';
import ProductsTable from '../components/tables/ProductsTable';
import type { Product } from '../types/product';
import type { Store } from '../types/store';
import { exportToXls } from '../utils/exportXls';


function StoreSettings({ store, onSaved }: { store: Store; onSaved: (s: Store) => void }) {
  const [form, setForm] = useState({
    default_roi: store.default_roi != null ? String(store.default_roi) : '',
    tax_rate: store.tax_rate != null ? String(store.tax_rate) : '',
    early_ship_discount: store.early_ship_discount != null ? String(store.early_ship_discount) : '0',
    selling_program: store.selling_program ?? 'FBS',
    payout_frequency: store.payout_frequency ?? 'MONTHLY',
    stock_min: store.stock_min != null ? String(store.stock_min) : '20',
    stock_max: store.stock_max != null ? String(store.stock_max) : '50',
    auto_promo_sync: store.auto_promo_sync ?? false,
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, number | string | boolean> = {};
      if (form.default_roi !== '') payload.default_roi = parseFloat(form.default_roi);
      if (form.tax_rate !== '') payload.tax_rate = parseFloat(form.tax_rate);
      if (form.early_ship_discount !== '') payload.early_ship_discount = parseFloat(form.early_ship_discount);
      payload.selling_program = form.selling_program;
      payload.payout_frequency = form.payout_frequency;
      if (form.stock_min !== '') payload.stock_min = parseInt(form.stock_min, 10);
      if (form.stock_max !== '') payload.stock_max = parseInt(form.stock_max, 10);
      payload.auto_promo_sync = form.auto_promo_sync;
      const updated = await updateStore(String(store.id), payload);
      onSaved(updated);
    } finally {
      setSaving(false);
    }
  }

  const fieldStyle = {
    display: 'flex', flexDirection: 'column' as const, gap: '4px',
  };
  const inputStyle = {
    padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', width: '120px',
  };
  const selectStyle = { width: '120px' };
  const labelStyle = { fontSize: '12px', color: '#6b7280' };

  return (
    <div className="card" style={{ marginBottom: '24px' }}>
      <div style={{ fontWeight: 700, marginBottom: '16px' }}>Параметры магазина</div>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={fieldStyle}>
          <span style={labelStyle}>ROI по умолчанию</span>
          <input style={inputStyle} type="number" step="0.01" value={form.default_roi}
            onChange={(e) => setForm({ ...form, default_roi: e.target.value })} placeholder="0.20" />
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Налог</span>
          <input style={inputStyle} type="number" step="0.01" value={form.tax_rate}
            onChange={(e) => setForm({ ...form, tax_rate: e.target.value })} placeholder="0.06" />
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Скидка за раннюю отгрузку</span>
          <select className="select-input" style={selectStyle} value={form.early_ship_discount}
            onChange={(e) => setForm({ ...form, early_ship_discount: e.target.value })}>
            <option value="7">До 28 ч — 7 п.п.</option>
            <option value="4">До 36 ч — 4 п.п.</option>
            <option value="0">Без скидки</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Модель продаж</span>
          <select className="select-input" style={selectStyle} value={form.selling_program}
            onChange={(e) => setForm({ ...form, selling_program: e.target.value })}>
            <option value="FBS">FBS</option>
            <option value="FBY">FBY</option>
            <option value="DBS">DBS</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Частота выплат</span>
          <select className="select-input" style={{ width: '280px' }} value={form.payout_frequency}
            onChange={(e) => setForm({ ...form, payout_frequency: e.target.value })}>
            <option value="MONTHLY">Раз в неделю, отсрочка 4 нед. — 1.6%</option>
            <option value="BIWEEKLY">Раз в неделю, отсрочка 2 нед. — 2.3%</option>
            <option value="WEEKLY">Раз в неделю, отсрочка 1 нед. — 2.8%</option>
            <option value="DAILY">Ежедневно — 3.3%</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Остаток — мин.</span>
          <input style={inputStyle} type="number" min="1" step="1" value={form.stock_min}
            onChange={(e) => setForm({ ...form, stock_min: e.target.value })} placeholder="20" />
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Остаток — макс.</span>
          <input style={inputStyle} type="number" min="1" step="1" value={form.stock_max}
            onChange={(e) => setForm({ ...form, stock_max: e.target.value })} placeholder="50" />
        </div>
        <button className="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}

type StoreCache = {
  store: Store; products: Product[];
  search: string; sortKey: string | null; sortDir: 'asc' | 'desc';
  statusFilter: string; ymFilter: string;
};

export default function StorePage() {
  const { storeId } = useParams<{ storeId: string }>();

  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [ymFilter, setYmFilter] = useState<string>('all');

  useEffect(() => {
    if (!storeId) return;
    const cacheKey = `store_page_${storeId}`;
    const rawCached = loadCache<StoreCache>(cacheKey);
    const cached = rawCached?.store && rawCached.store.last_sync_at === undefined ? null : rawCached;

    if (cached) {
      setStore(cached.store);
      setProducts(cached.products);
      setSearch(cached.search ?? '');
      setSortKey(cached.sortKey ?? null);
      setSortDir(cached.sortDir ?? 'asc');
      setStatusFilter(cached.statusFilter ?? 'all');
      setYmFilter(cached.ymFilter ?? 'all');
      setLoading(false);
      return;
    }

    setStore(null);
    setProducts([]);
    setSearch('');
    setSortKey(null);
    setSortDir('asc');
    setStatusFilter('all');
    setYmFilter('all');
    setLoading(true);
    setError(null);
    Promise.all([fetchStore(storeId), fetchAssortment(storeId)])
      .then(([s, p]) => { setStore(s); setProducts(p); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [storeId]);

  // Сохраняем в кэш при изменениях
  useEffect(() => {
    if (!loading && store && storeId) {
      saveCache<StoreCache>(`store_page_${storeId}`, { store, products, search, sortKey, sortDir, statusFilter, ymFilter });
    }
  }, [store, products, search, sortKey, sortDir, statusFilter, ymFilter, loading, storeId]);

  async function handleSync() {
    if (!storeId) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await syncStore(storeId);
      const [updatedStore, updated] = await Promise.all([fetchStore(storeId), fetchAssortment(storeId)]);
      setStore(updatedStore);
      setProducts(updated);
      clearCache(CACHE_KEYS.uploadPrices, CACHE_KEYS.matching);
      alert(`Синхронизировано ${result.synced} товаров`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  function handleProductUpdated(updated: Product) {
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const filtered = products
    .filter((p) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!p.sku.toLowerCase().includes(q) && !(p.name ?? '').toLowerCase().includes(q)) return false;
      }
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (ymFilter !== 'all' && p.ym_availability !== ymFilter) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
    if (!sortKey) return 0;
    const av = (a as any)[sortKey];
    const bv = (b as any)[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv, 'ru') : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const storeName = store?.display_name ?? store?.name ?? storeId;

  function formatSyncTime(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <h1 style={{ margin: 0 }}>{storeName}</h1>
        <button className="button" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Синхронизация...' : 'Синхронизировать из ЯМ'}
        </button>
        <span style={{ fontSize: '13px', color: '#9ca3af' }}>
          {store
            ? store.last_sync_at
              ? `последняя синхронизация: ${formatSyncTime(store.last_sync_at)}`
              : 'не синхронизировался'
            : ''}
        </span>
      </div>

      {error && <div style={{ color: 'red', marginBottom: '16px' }}>{error}</div>}

      {store && <StoreSettings store={store} onSaved={setStore} />}

      {loading ? (
        <LoadingCats />
      ) : products.length === 0 ? (
        <p>Нет товаров. Нажмите «Синхронизировать из ЯМ» для загрузки ассортимента.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Поиск по SKU или названию..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px', width: '260px' }}
            />
            <select
              className="select-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">Все статусы</option>
              <option value="active">Активные</option>
              <option value="updated">Обновлённые</option>
              <option value="zeroed">Обнулённые</option>
              <option value="error">Ошибка</option>
            </select>
            <select
              className="select-input"
              value={ymFilter}
              onChange={(e) => setYmFilter(e.target.value)}
            >
              <option value="all">Все статусы ЯМ</option>
              <option value="PUBLISHED">Готов к продаже</option>
              <option value="CHECKING">На проверке</option>
              <option value="NO_STOCKS">Нет на складе</option>
              <option value="HIDDEN">Скрыт</option>
              <option value="SUSPENDED">Приостановлен</option>
              <option value="DISABLED">Отключён</option>
              <option value="REJECTED">Отклонён</option>
              <option value="DISABLED_AUTOMATICALLY">Есть ошибки</option>
            </select>
            <span style={{ color: '#666', fontSize: '14px' }}>
              {filtered.length} из {products.length} товаров
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
            <button
              onClick={() => exportToXls(filtered.map((p) => ({
                'SKU': p.sku,
                'Название': p.name ?? '',
                'Цена': p.price ?? '',
                'Закупка': p.supplier_price ?? '',
                'Прибыль': p.profit ?? '',
                'ROI': p.actual_roi != null ? `${Math.round(p.actual_roi * 100)}%` : '',
                'Остаток': p.stock ?? '',
                'Продаётся': p.enabled ? 'Да' : 'Нет',
                'Категория': p.category ?? '',
                'Комиссия': p.commission != null ? `${p.commission}%` : '',
                'Статус': p.status ?? '',
                'Обновлено': p.last_price_update ?? '',
              })), `ассортимент_${store?.name ?? ''}`)}
              style={{
                padding: '3px 10px', fontSize: '12px', background: '#fff',
                border: '1px solid #e5e7eb', borderRadius: '6px', cursor: 'pointer', color: '#6b7280',
              }}
            >
              ↓ XLS
            </button>
          </div>
          <ProductsTable items={filtered} storeDefaultRoi={store?.default_roi ?? null} onProductUpdated={handleProductUpdated} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
        </>
      )}
    </div>
  );
}
