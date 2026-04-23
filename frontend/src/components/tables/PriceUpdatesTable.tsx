import { useEffect, useRef, useState } from 'react';
import { confirmPriceUpdate } from '../../api/prices';
import { fetchAllStores } from '../../api/stores';
import type { PriceUpdate, TariffItem } from '../../types/priceUpdate';

// ─── константы ────────────────────────────────────────────────────────────────

const STORE_COLORS = [
  { bg: '#eff6ff', text: '#1d4ed8' },
  { bg: '#f0fdf4', text: '#166534' },
  { bg: '#faf5ff', text: '#7e22ce' },
  { bg: '#fff7ed', text: '#c2410c' },
  { bg: '#f0f9ff', text: '#0369a1' },
];
function storeColor(storeId: number) { return STORE_COLORS[(storeId - 1) % STORE_COLORS.length]; }

const STATUS_LABELS: Record<string, string> = {
  calculated: 'Рассчитано',
  applied: 'Применено',
  zeroed: 'Обнулён',
  will_zero: 'Будет обнулён',
  error: 'Ошибка',
};

const STATUS_CLASS: Record<string, string> = {
  calculated: 'calculated',
  applied: 'active',
  zeroed: 'zeroed',
  will_zero: 'zeroed',
  error: 'error',
};

const TARIFF_LABELS: Record<string, string> = {
  FEE: 'Комиссия ЯМ',
  DELIVERY_TO_CUSTOMER: 'Доставка до покупателя',
  MIDDLE_MILE: 'Магистраль',
  PAYMENT_TRANSFER: 'Перевод платежа',
  AGENCY_COMMISSION: 'Агентская комиссия',
  FF: 'Фулфилмент',
  INSTALLMENT: 'Рассрочка',
  STORAGE: 'Хранение',
  RETURNED_ORDERS_STORAGE: 'Хранение возвратов',
  CASH_ONLY: 'Наложенный платёж',
  TAX: 'Налог (УСН)',
};

// ─── колонки ──────────────────────────────────────────────────────────────────

type ColKey =
  | 'store' | 'sku' | 'supplier' | 'supplier_price'
  | 'old_price' | 'new_price' | 'difference' | 'difference_pct'
  | 'stock' | 'profit' | 'actual_roi' | 'status' | 'created_at';

const ALL_COLS: { key: ColKey; label: string; defaultWidth: number; sortable: boolean }[] = [
  { key: 'store',          label: 'Магазин',     defaultWidth: 80,  sortable: true  },
  { key: 'sku',            label: 'SKU',          defaultWidth: 200, sortable: true  },
  { key: 'supplier',       label: 'Поставщик',    defaultWidth: 120, sortable: true  },
  { key: 'supplier_price', label: 'Закупка',      defaultWidth: 100, sortable: true  },
  { key: 'old_price',      label: 'Старая цена',  defaultWidth: 110, sortable: true  },
  { key: 'new_price',      label: 'Новая цена',   defaultWidth: 110, sortable: true  },
  { key: 'difference',     label: 'Изм. ₽',       defaultWidth: 100, sortable: true  },
  { key: 'difference_pct', label: 'Изм. %',       defaultWidth: 90,  sortable: true  },
  { key: 'stock',          label: 'Остаток',      defaultWidth: 110, sortable: false },
  { key: 'profit',         label: 'Прибыль',      defaultWidth: 110, sortable: true  },
  { key: 'actual_roi',     label: 'ROI',          defaultWidth: 80,  sortable: true  },
  { key: 'status',         label: 'Статус',       defaultWidth: 115, sortable: true  },
  { key: 'created_at',     label: 'Дата',         defaultWidth: 110, sortable: true  },
];

const ACTION_WIDTH = 130;
const LS_VISIBLE = 'pu_table_visible_v2';
const LS_WIDTHS  = 'pu_table_widths_v2';

function loadVisible(): Set<ColKey> {
  try {
    const raw = localStorage.getItem(LS_VISIBLE);
    if (raw) return new Set(JSON.parse(raw) as ColKey[]);
  } catch {}
  return new Set(ALL_COLS.map(c => c.key));
}

function loadWidths(): Record<ColKey, number> {
  const defaults = Object.fromEntries(ALL_COLS.map(c => [c.key, c.defaultWidth])) as Record<ColKey, number>;
  try {
    const raw = localStorage.getItem(LS_WIDTHS);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {}
  return defaults;
}

// ─── фильтр по дате ───────────────────────────────────────────────────────────

type DateFilter = 'all' | 'today' | 'yesterday' | 'week';

const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  all: 'Все',
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Неделя',
};

function passesDateFilter(item: PriceUpdate, filter: DateFilter): boolean {
  if (filter === 'all') return true;
  if (!item.created_at) return false;
  const d = new Date(item.created_at);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (filter === 'today') return d >= today;
  if (filter === 'yesterday') {
    const yesterday = new Date(today.getTime() - 86_400_000);
    return d >= yesterday && d < today;
  }
  if (filter === 'week') return d >= new Date(today.getTime() - 6 * 86_400_000);
  return true;
}

// ─── сортировка ───────────────────────────────────────────────────────────────

function getSortValue(item: PriceUpdate, key: ColKey): string | number | null {
  switch (key) {
    case 'store':          return item.store_id;
    case 'sku':            return item.sku;
    case 'supplier':       return item.supplier ?? '';
    case 'supplier_price': return item.supplier_price;
    case 'old_price':      return item.old_price;
    case 'new_price':      return item.new_price;
    case 'difference':     return item.difference;
    case 'difference_pct': return item.difference_pct;
    case 'profit':         return item.profit;
    case 'actual_roi':     return item.actual_roi;
    case 'status':         return item.status;
    case 'created_at':     return item.created_at ? new Date(item.created_at).getTime() : null;
    default:               return null;
  }
}

function sortItems(items: PriceUpdate[], key: ColKey | null, dir: 'asc' | 'desc'): PriceUpdate[] {
  return [...items].sort((a, b) => {
    // Товары, требующие подтверждения — всегда наверху
    const aNeedsConfirm = a.requires_confirmation && a.status === 'calculated' ? 0 : 1;
    const bNeedsConfirm = b.requires_confirmation && b.status === 'calculated' ? 0 : 1;
    if (aNeedsConfirm !== bNeedsConfirm) return aNeedsConfirm - bNeedsConfirm;

    if (!key) return 0;
    const av = getSortValue(a, key);
    const bv = getSortValue(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string, 'ru') : (av as number) - (bv as number);
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ─── форматирование ───────────────────────────────────────────────────────────

function fmt(price: number | null) {
  if (price == null) return '—';
  return price.toLocaleString('ru-RU') + ' ₽';
}

function diffLabel(diff: number | null) {
  if (diff == null) return '—';
  return (diff > 0 ? '+' : '') + diff.toLocaleString('ru-RU') + ' ₽';
}

function fmtPct(pct: number | null, diff: number | null) {
  if (pct == null) return '—';
  return (diff != null && diff > 0 ? '+' : '') + pct.toFixed(1) + '%';
}

function fmtStock(old_s: number | null, new_s: number | null) {
  if (old_s == null && new_s == null) return '—';
  const o = old_s ?? '?';
  const n = new_s ?? '?';
  if (old_s === new_s) return String(n);
  const color = new_s === 0 ? '#dc2626' : new_s != null && old_s != null && new_s > old_s ? '#16a34a' : '#d97706';
  return <span style={{ color, fontWeight: 600 }}>{o} → {n}</span>;
}

function parseTariffs(json: string | null): TariffItem[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

// ─── подкомпоненты ────────────────────────────────────────────────────────────

function ConfirmButton({ item, onUpdated }: { item: PriceUpdate; onUpdated: (u: PriceUpdate) => void }) {
  const [loading, setLoading] = useState(false);
  async function handle() {
    setLoading(true);
    try { onUpdated(await confirmPriceUpdate(item.id)); }
    finally { setLoading(false); }
  }
  return (
    <button onClick={handle} disabled={loading} style={{
      padding: '4px 10px', fontSize: '12px', background: '#f59e0b',
      color: 'white', border: 'none', borderRadius: '6px',
      cursor: loading ? 'wait' : 'pointer', whiteSpace: 'nowrap',
    }}>
      {loading ? '...' : 'Подтвердить'}
    </button>
  );
}

function TariffsRow({ tariffs, newPrice, colSpan }: { tariffs: TariffItem[]; newPrice: number | null; colSpan: number }) {
  if (tariffs.length === 0) return null;
  const total = tariffs.reduce((s, t) => s + t.amount, 0);
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '0 0 8px 32px', background: '#f9fafb' }}>
        <div style={{ padding: '8px 12px', background: '#f1f5f9', borderRadius: '6px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px' }}>
            {tariffs.map((t, i) => {
              const pct = t.pct ?? (newPrice && newPrice > 0 ? (t.amount / newPrice) * 100 : null);
              const isTax = t.type === 'TAX';
              return (
                <span key={i} style={{ fontSize: '12px', color: '#374151', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                  <span style={{ color: isTax ? '#7c3aed' : '#6b7280', fontWeight: 500 }}>
                    {TARIFF_LABELS[t.type] ?? t.type}
                  </span>
                  <span>
                    <strong>{t.amount.toLocaleString('ru-RU')} ₽</strong>
                    {pct != null && <span style={{ color: '#9ca3af', marginLeft: '4px' }}>({pct.toFixed(1)}%)</span>}
                  </span>
                </span>
              );
            })}
          </div>
          {newPrice && newPrice > 0 && (
            <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e2e8f0', fontSize: '12px', color: '#374151', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ color: '#6b7280' }}>Итого издержек:</span>
              <strong>{total.toLocaleString('ru-RU')} ₽</strong>
              <span style={{ color: '#9ca3af' }}>({((total / newPrice) * 100).toFixed(1)}% от цены)</span>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    startX.current = e.clientX;

    function onMove(ev: MouseEvent) {
      onResize(ev.clientX - startX.current);
      startX.current = ev.clientX;
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <span
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: '5px',
        cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1,
      }}
    >
      <span style={{
        width: '2px', height: '60%', borderRadius: '1px',
        background: dragging ? '#2563eb' : '#d1d5db',
        transition: 'background 0.15s',
      }} />
    </span>
  );
}

// ─── главный компонент ────────────────────────────────────────────────────────

type Props = {
  items: PriceUpdate[];
  onUpdated: (updated: PriceUpdate) => void;
};

export default function PriceUpdatesTable({ items, onUpdated }: Props) {
  const [storeNames, setStoreNames] = useState<Record<number, string>>({});
  useEffect(() => {
    fetchAllStores().then((stores) => {
      setStoreNames(Object.fromEntries(stores.map((s) => [s.id, s.display_name ?? s.name])));
    }).catch(() => {});
  }, []);

  const [expanded,    setExpanded]    = useState<Set<number>>(new Set());
  const [sortKey,     setSortKey]     = useState<ColKey | null>(null);
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('desc');
  const [dateFilter,  setDateFilter]  = useState<DateFilter>('all');
  const [showColMenu, setShowColMenu] = useState(false);
  const [visible,     setVisible]     = useState<Set<ColKey>>(loadVisible);
  const [colWidths,   setColWidths]   = useState<Record<ColKey, number>>(loadWidths);

  useEffect(() => {
    localStorage.setItem(LS_VISIBLE, JSON.stringify([...visible]));
  }, [visible]);

  useEffect(() => {
    localStorage.setItem(LS_WIDTHS, JSON.stringify(colWidths));
  }, [colWidths]);

  const visibleCols = ALL_COLS.filter(c => visible.has(c.key));

  function toggleCol(key: ColKey) {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(key) && next.size > 1) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleSort(key: ColKey, sortable: boolean) {
    if (!sortable) return;
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return key; }
      setSortDir('desc');
      return key;
    });
  }

  function resizeCol(key: ColKey, delta: number) {
    setColWidths(prev => ({ ...prev, [key]: Math.max(50, (prev[key] ?? 100) + delta) }));
  }

  function toggle(id: number) {
    setExpanded(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
    });
  }

  const filtered = items.filter(item => passesDateFilter(item, dateFilter));
  const sorted   = sortItems(filtered, sortKey, sortDir);

  const tableWidth = visibleCols.reduce((s, c) => s + colWidths[c.key], 0) + ACTION_WIDTH;
  const totalCols  = visibleCols.length + 1; // +1 action

  if (items.length === 0) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>
        Нет данных. Загрузите прайс и нажмите «Пересчитать».
      </div>
    );
  }

  return (
    <div>
      {/* ── панель управления ── */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        {/* фильтр по дате */}
        <div style={{ display: 'flex', gap: '2px', background: '#f3f4f6', borderRadius: '8px', padding: '3px' }}>
          {(['all', 'today', 'yesterday', 'week'] as DateFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setDateFilter(f)}
              style={{
                padding: '4px 10px', fontSize: '12px', border: 'none', borderRadius: '6px',
                cursor: 'pointer', fontWeight: dateFilter === f ? 600 : 400,
                background: dateFilter === f ? 'white' : 'transparent',
                color: dateFilter === f ? '#111827' : '#6b7280',
                boxShadow: dateFilter === f ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              {DATE_FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {/* кнопка настройки столбцов */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowColMenu(v => !v)}
            style={{
              padding: '4px 10px', fontSize: '12px', border: '1px solid #d1d5db',
              borderRadius: '6px', background: 'white', cursor: 'pointer', color: '#374151',
            }}
          >
            Столбцы ▾
          </button>
          {showColMenu && (
            <div style={{
              position: 'absolute', top: '110%', left: 0, background: 'white',
              border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 100, minWidth: '160px',
            }}>
              {ALL_COLS.map(c => (
                <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', cursor: 'pointer', fontSize: '13px', borderRadius: '4px', userSelect: 'none' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <input type="checkbox" checked={visible.has(c.key)} onChange={() => toggleCol(c.key)} style={{ cursor: 'pointer' }} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>

        {filtered.length !== items.length && (
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            Показано {filtered.length} из {items.length}
          </span>
        )}
      </div>

      {/* ── таблица ── */}
      <div className="table-wrapper">
        <table className="table" style={{ tableLayout: 'fixed', width: `${tableWidth}px` }}>
          <colgroup>
            {visibleCols.map(c => <col key={c.key} style={{ width: `${colWidths[c.key]}px` }} />)}
            <col style={{ width: `${ACTION_WIDTH}px` }} />
          </colgroup>
          <thead>
            <tr>
              {visibleCols.map(c => (
                <th
                  key={c.key}
                  style={{ position: 'relative', userSelect: 'none', cursor: c.sortable ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  onClick={() => handleSort(c.key, c.sortable)}
                >
                  {c.label}
                  {c.sortable && sortKey === c.key && (
                    <span style={{ marginLeft: '4px', fontSize: '10px' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                  <ResizeHandle onResize={d => resizeCol(c.key, d)} />
                </th>
              ))}
              <th style={{ position: 'relative' }}>Действие</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => {
              const needsConfirm = item.requires_confirmation && item.status === 'calculated';
              const tariffs   = parseTariffs(item.tariffs_json);
              const isExpanded = expanded.has(item.id);
              const hasTariffs = tariffs.length > 0;
              const isZeroed   = item.status === 'zeroed' || item.status === 'will_zero';

              return [
                <tr
                  key={item.id}
                  style={{
                    background: isZeroed ? '#fef2f2' : needsConfirm ? '#fffbeb' : undefined,
                    opacity: item.status === 'applied' ? 0.6 : 1,
                  }}
                >
                  {visibleCols.map(c => {
                    const s: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
                    switch (c.key) {
                      case 'store': return (
                        <td key={c.key} style={s}>
                          <span style={{
                            fontSize: '12px', fontWeight: 600, padding: '2px 6px', borderRadius: '4px',
                            background: storeColor(item.store_id).bg,
                            color: storeColor(item.store_id).text,
                          }}>
                            {storeNames[item.store_id] ?? item.store_id}
                          </span>
                        </td>
                      );
                      case 'sku': return <td key={c.key} style={{ ...s, fontFamily: 'monospace', fontSize: '12px' }}>{item.sku}</td>;
                      case 'supplier': return <td key={c.key} style={{ ...s, fontSize: '12px', color: '#6b7280' }}>{item.supplier ?? '—'}</td>;
                      case 'supplier_price': return <td key={c.key} style={{ ...s, fontSize: '13px' }}>{fmt(item.supplier_price)}</td>;
                      case 'old_price': return <td key={c.key} style={{ ...s, fontSize: '13px', color: '#9ca3af' }}>{isZeroed ? '—' : fmt(item.old_price)}</td>;
                      case 'new_price': return <td key={c.key} style={{ ...s, fontWeight: 600 }}>{isZeroed ? '—' : fmt(item.new_price)}</td>;
                      case 'difference': return (
                        <td key={c.key} style={{ ...s, fontSize: '13px', color: item.difference != null && item.difference > 0 ? '#16a34a' : '#dc2626' }}>
                          {isZeroed ? '—' : diffLabel(item.difference)}
                        </td>
                      );
                      case 'difference_pct': return (
                        <td key={c.key} style={{ ...s, fontSize: '13px' }}>
                          {isZeroed ? '—' : needsConfirm
                            ? <span style={{ color: '#b45309', fontWeight: 700 }}>⚠ {fmtPct(item.difference_pct, item.difference)}</span>
                            : <span style={{ color: item.difference != null && item.difference > 0 ? '#16a34a' : '#dc2626' }}>{fmtPct(item.difference_pct, item.difference)}</span>
                          }
                        </td>
                      );
                      case 'stock': return <td key={c.key} style={{ ...s, fontSize: '13px' }}>{fmtStock(item.old_stock, item.new_stock)}</td>;
                      case 'profit': return (
                        <td key={c.key} style={{ ...s, fontSize: '13px', fontWeight: 600, color: item.profit != null && item.profit > 0 ? '#16a34a' : '#dc2626' }}>
                          {isZeroed ? '—' : fmt(item.profit)}
                        </td>
                      );
                      case 'actual_roi': return (
                        <td key={c.key} style={{ ...s, fontSize: '13px' }}>
                          {!isZeroed && item.actual_roi != null
                            ? <span style={{ color: item.actual_roi >= 15 ? '#16a34a' : item.actual_roi >= 10 ? '#d97706' : '#dc2626' }}>{item.actual_roi.toFixed(1)}%</span>
                            : '—'}
                        </td>
                      );
                      case 'status': return (
                        <td key={c.key} style={s}>
                          <span className={`badge badge--${STATUS_CLASS[item.status] ?? 'pending'}`}>
                            {STATUS_LABELS[item.status] ?? item.status}
                          </span>
                        </td>
                      );
                      case 'created_at': return (
                        <td key={c.key} style={{ ...s, fontSize: '11px', color: '#9ca3af' }}>
                          {item.created_at ? new Date(item.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                      );
                      default: return <td key={c.key} />;
                    }
                  })}
                  <td>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {needsConfirm && <ConfirmButton item={item} onUpdated={onUpdated} />}
                      {hasTariffs && (
                        <button
                          onClick={() => toggle(item.id)}
                          style={{
                            padding: '3px 8px', fontSize: '11px', background: 'none',
                            border: '1px solid #d1d5db', borderRadius: '4px',
                            cursor: 'pointer', color: '#6b7280', whiteSpace: 'nowrap',
                          }}
                        >
                          {isExpanded ? '▲ скрыть' : '▼ тарифы'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>,
                isExpanded && hasTariffs
                  ? <TariffsRow key={`${item.id}-t`} tariffs={tariffs} newPrice={item.new_price} colSpan={totalCols} />
                  : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
