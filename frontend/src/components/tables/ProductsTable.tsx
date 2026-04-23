import { useEffect, useRef, useState } from 'react';
import { updateProduct } from '../../api/assortment';
import type { Product } from '../../types/product';
import StatusBadge, { YmStatusBadge } from '../ui/StatusBadge';

// ─── колонки ──────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'sku',               label: 'SKU',           sortField: 'sku',               defaultVisible: true,  defaultWidth: 130 },
  { key: 'name',              label: 'Название',      sortField: 'name',              defaultVisible: true,  defaultWidth: 200 },
  { key: 'price',             label: 'Цена',          sortField: 'price',             defaultVisible: true,  defaultWidth: 90  },
  { key: 'supplier_price',    label: 'Закупка',       sortField: 'supplier_price',    defaultVisible: true,  defaultWidth: 90  },
  { key: 'profit',            label: 'Прибыль',       sortField: 'profit',            defaultVisible: true,  defaultWidth: 90  },
  { key: 'current_roi',       label: 'ROI',           sortField: 'actual_roi',        defaultVisible: true,  defaultWidth: 70  },
  { key: 'ros',               label: 'ROS',           sortField: null,                defaultVisible: true,  defaultWidth: 70  },
  { key: 'stock',             label: 'Остаток',       sortField: 'stock',             defaultVisible: true,  defaultWidth: 90  },
  { key: 'enabled',           label: 'Прод.',         sortField: null,                defaultVisible: true,  defaultWidth: 60  },
  { key: 'ym_availability',   label: 'Статус ЯМ',     sortField: 'ym_availability',   defaultVisible: true,  defaultWidth: 120 },
  { key: 'last_price_update', label: 'Обновлено',     sortField: 'last_price_update', defaultVisible: true,  defaultWidth: 100 },
  // скрытые по умолчанию
  { key: 'roi_edit',          label: 'ROI (инд.)',    sortField: 'roi',               defaultVisible: false, defaultWidth: 80  },
  { key: 'commission',        label: 'Комиссия',      sortField: 'commission',        defaultVisible: false, defaultWidth: 90  },
  { key: 'category',          label: 'Категория',     sortField: 'category',          defaultVisible: false, defaultWidth: 160 },
  { key: 'status',            label: 'Статус',        sortField: 'status',            defaultVisible: false, defaultWidth: 100 },
  { key: 'ym_processing',     label: 'Обработка ЯМ',  sortField: null,               defaultVisible: false, defaultWidth: 120 },
] as const;

type ColKey = typeof COLUMNS[number]['key'];

const DEFAULT_VISIBLE = new Set<ColKey>(
  COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key)
);

const DEFAULT_WIDTHS: Record<ColKey, number> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c.defaultWidth])
) as Record<ColKey, number>;

const LS_VISIBLE = 'assortment-visible-cols';
const LS_WIDTHS  = 'assortment-col-widths';

function loadVisible(): Set<ColKey> {
  try {
    const raw = localStorage.getItem(LS_VISIBLE);
    if (raw) return new Set(JSON.parse(raw) as ColKey[]);
  } catch {}
  return new Set(DEFAULT_VISIBLE);
}

function loadWidths(): Record<ColKey, number> {
  try {
    const raw = localStorage.getItem(LS_WIDTHS);
    if (raw) return { ...DEFAULT_WIDTHS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_WIDTHS };
}

// ─── хелперы ──────────────────────────────────────────────────────────────────

function fmt(v: number | null, suffix = ' ₽') {
  if (v == null) return '—';
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + suffix;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const h     = String(d.getHours()).padStart(2, '0');
  const m     = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month} в ${h}:${m}`;
}

// ─── редактируемые ячейки ────────────────────────────────────────────────────

function RoiCell({ product, onUpdated }: { product: Product; onUpdated: (p: Product) => void }) {
  const [value, setValue] = useState(product.roi != null ? String(product.roi) : '');
  const [saving, setSaving] = useState(false);

  async function handleBlur() {
    const trimmed = value.trim();
    const num = trimmed === '' ? null : parseFloat(trimmed);
    if (num === product.roi) return;
    setSaving(true);
    try {
      const updated = await updateProduct(product.id, { roi: num ?? undefined });
      onUpdated(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      disabled={saving}
      placeholder="—"
      style={{ width: '56px', padding: '3px 5px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
    />
  );
}

function StockCell({ product, onUpdated }: { product: Product; onUpdated: (p: Product) => void }) {
  const [value, setValue] = useState(product.stock != null ? String(product.stock) : '');
  const [saving, setSaving] = useState(false);

  async function handleBlur() {
    const num = parseInt(value, 10);
    if (isNaN(num) || num === product.stock) return;
    setSaving(true);
    try {
      const updated = await updateProduct(product.id, { stock: num });
      onUpdated(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      type="number"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      disabled={saving}
      placeholder="—"
      style={{ width: '56px', padding: '3px 5px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px' }}
    />
  );
}

function EnabledCell({ product, onUpdated }: { product: Product; onUpdated: (p: Product) => void }) {
  const [saving, setSaving] = useState(false);
  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSaving(true);
    try { onUpdated(await updateProduct(product.id, { enabled: e.target.checked })); }
    finally { setSaving(false); }
  }
  return (
    <input type="checkbox" checked={product.enabled} onChange={handleChange} disabled={saving}
      style={{ cursor: saving ? 'wait' : 'pointer', width: '16px', height: '16px' }} />
  );
}

// ─── попап выбора столбцов ────────────────────────────────────────────────────

function ColumnPicker({ visible, onChange }: { visible: Set<ColKey>; onChange: (v: Set<ColKey>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  function toggle(key: ColKey) {
    const next = new Set(visible);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange(next);
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '6px 12px', fontSize: '13px', background: open ? '#e0e7ff' : '#f3f4f6',
          border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', color: '#374151',
        }}
      >
        Столбцы {open ? '▲' : '▼'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '36px', right: 0, background: '#fff',
          border: '1px solid #d1d5db', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          zIndex: 200, padding: '8px 0', minWidth: '200px',
        }}>
          {COLUMNS.map((col) => (
            <label
              key={col.key}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 16px', cursor: 'pointer', fontSize: '13px', color: '#374151',
              }}
            >
              <input type="checkbox" checked={visible.has(col.key)} onChange={() => toggle(col.key)}
                style={{ width: '14px', height: '14px' }} />
              {col.label}
              {!col.defaultVisible && (
                <span style={{ fontSize: '10px', color: '#9ca3af', marginLeft: 'auto' }}>доп.</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── resize handle ────────────────────────────────────────────────────────────

function ResizeHandle({ colKey, onResize }: { colKey: ColKey; onResize: (key: ColKey, delta: number) => void }) {
  const startX = useRef<number>(0);
  const [dragging, setDragging] = useState(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startX.current = e.clientX;
    setDragging(true);

    function onMouseMove(ev: MouseEvent) {
      onResize(colKey, ev.clientX - startX.current);
      startX.current = ev.clientX;
    }
    function onMouseUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div
      onMouseDown={onMouseDown}
      title="Перетащите для изменения ширины"
      style={{
        position: 'absolute', right: 0, top: '20%', bottom: '20%',
        width: '4px', cursor: 'col-resize', userSelect: 'none',
        borderRadius: '2px',
        background: dragging ? '#2563eb' : '#d1d5db',
        opacity: dragging ? 1 : 0.7,
        transition: 'background 0.15s',
        zIndex: 10,
      }}
      onMouseEnter={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = '#93c5fd'; }}
      onMouseLeave={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = '#d1d5db'; }}
    />
  );
}

// ─── таблица ─────────────────────────────────────────────────────────────────

type Props = {
  items: Product[];
  storeDefaultRoi?: number | null;
  onProductUpdated: (updated: Product) => void;
  sortKey?: string | null;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
};

export default function ProductsTable({ items, storeDefaultRoi, onProductUpdated, sortKey, sortDir, onSort }: Props) {
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(loadVisible);
  const [colWidths, setColWidths] = useState<Record<ColKey, number>>(loadWidths);

  useEffect(() => {
    localStorage.setItem(LS_VISIBLE, JSON.stringify([...visibleCols]));
  }, [visibleCols]);

  useEffect(() => {
    localStorage.setItem(LS_WIDTHS, JSON.stringify(colWidths));
  }, [colWidths]);

  function handleResize(key: ColKey, delta: number) {
    setColWidths((prev) => ({
      ...prev,
      [key]: Math.max(40, (prev[key] ?? DEFAULT_WIDTHS[key]) + delta),
    }));
  }

  function Th({ col }: { col: typeof COLUMNS[number] }) {
    const w = colWidths[col.key] ?? col.defaultWidth;
    const base: React.CSSProperties = {
      position: 'relative', whiteSpace: 'nowrap', width: `${w}px`,
      overflow: 'hidden', textOverflow: 'ellipsis',
    };
    const content = col.sortField && onSort ? (
      <span
        onClick={() => onSort(col.sortField!)}
        style={{ cursor: 'pointer', userSelect: 'none', color: sortKey === col.sortField ? '#2563eb' : undefined }}
        title={`Сортировать: ${col.label}`}
      >
        {col.label}{' '}
        <span style={{ fontSize: '11px', opacity: sortKey === col.sortField ? 1 : 0.35 }}>
          {sortKey === col.sortField ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    ) : <span>{col.label}</span>;

    return (
      <th style={base}>
        {content}
        <ResizeHandle colKey={col.key} onResize={handleResize} />
      </th>
    );
  }

  const vis = (key: ColKey) => visibleCols.has(key);
  const visibleList = COLUMNS.filter((c) => vis(c.key));
  const totalWidth = visibleList.reduce((s, c) => s + (colWidths[c.key] ?? c.defaultWidth), 0);

  return (
    <div>
      {/* Кнопка управления столбцами */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <ColumnPicker visible={visibleCols} onChange={setVisibleCols} />
      </div>

      <div className="table-wrapper">
        <table className="table" style={{ tableLayout: 'fixed', width: `${totalWidth}px` }}>
          <colgroup>
            {visibleList.map((col) => (
              <col key={col.key} style={{ width: `${colWidths[col.key] ?? col.defaultWidth}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleList.map((col) => (
                <Th key={col.key} col={col} />
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const effectiveRoi = p.actual_roi;
              const ros = (p.profit != null && p.price != null && p.price > 0)
                ? (p.profit / p.price * 100)
                : null;

              return (
                <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                  {vis('sku') && (
                    <td style={{ fontFamily: 'monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.sku}>{p.sku}</td>
                  )}
                  {vis('name') && (
                    <td style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name ?? ''}>{p.name ?? '—'}</td>
                  )}
                  {vis('price') && (
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(p.price)}</td>
                  )}
                  {vis('supplier_price') && (
                    <td style={{ whiteSpace: 'nowrap', color: '#6b7280' }}>{fmt(p.supplier_price)}</td>
                  )}
                  {vis('profit') && (
                    <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: p.profit != null && p.profit > 0 ? '#16a34a' : p.profit != null ? '#dc2626' : '#9ca3af' }}>
                      {fmt(p.profit)}
                    </td>
                  )}
                  {vis('current_roi') && (
                    <td style={{ whiteSpace: 'nowrap', fontSize: '13px' }}>
                      {effectiveRoi != null ? (
                        <span style={{ color: effectiveRoi >= 20 ? '#16a34a' : effectiveRoi >= 10 ? '#d97706' : '#dc2626' }}>
                          {effectiveRoi.toFixed(1)}%
                        </span>
                      ) : storeDefaultRoi != null ? (
                        <span style={{ color: '#9ca3af' }}>{(storeDefaultRoi * 100).toFixed(0)}%*</span>
                      ) : '—'}
                    </td>
                  )}
                  {vis('ros') && (
                    <td style={{ whiteSpace: 'nowrap', fontSize: '13px' }}>
                      {ros != null ? (
                        <span style={{ color: ros >= 15 ? '#16a34a' : ros >= 8 ? '#d97706' : '#dc2626' }}>
                          {ros.toFixed(1)}%
                        </span>
                      ) : '—'}
                    </td>
                  )}
                  {vis('stock') && (
                    <td><StockCell product={p} onUpdated={onProductUpdated} /></td>
                  )}
                  {vis('enabled') && (
                    <td><EnabledCell product={p} onUpdated={onProductUpdated} /></td>
                  )}
                  {vis('ym_availability') && (
                    <td><YmStatusBadge status={p.ym_availability} /></td>
                  )}
                  {vis('last_price_update') && (
                    <td style={{ whiteSpace: 'nowrap', fontSize: '12px', color: '#6b7280' }}>
                      {fmtDate(p.last_price_update)}
                    </td>
                  )}
                  {vis('roi_edit') && (
                    <td><RoiCell product={p} onUpdated={onProductUpdated} /></td>
                  )}
                  {vis('commission') && (
                    <td style={{ whiteSpace: 'nowrap', fontSize: '13px' }}>
                      {p.commission != null ? `${p.commission}%` : '—'}
                    </td>
                  )}
                  {vis('category') && (
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: '#6b7280' }} title={p.category ?? ''}>
                      {p.category ?? '—'}
                    </td>
                  )}
                  {vis('status') && (
                    <td>{p.status ? <StatusBadge status={p.status} /> : '—'}</td>
                  )}
                  {vis('ym_processing') && (
                    <td style={{ fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {p.ym_processing_status ?? '—'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
