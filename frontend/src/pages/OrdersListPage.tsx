import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { apiFetch } from '../api/client';
import { updateOrderSupplierPrice, updateOrderSerialNumber, syncActiveOrders, fetchOrdersSummary, fetchReceivables, syncOrders } from '../api/orders';
import type { OrdersSummary, DailyStats, Receivables } from '../types/order';
import LoadingCats from '../components/ui/LoadingCats';

// ─── типы ──────────────────────────────────────────────────────────────────────

interface FeeDetail { type: string; label: string; amount: number; pct: number; }

interface OrderRow {
  id: number; store_id: number; store_name: string; order_id: string;
  offer_name: string | null; sku: string | null; order_kind: string;
  ym_status: string | null; quantity: number; order_date: string | null;
  shipment_date: string | null; payment_date: string | null; serial_number: string | null;
  buyer_payment: number; promo_discount: number; revenue: number;
  fees_total: number; fee_details: FeeDetail[]; is_forecast: boolean;
  supplier_price: number | null; supplier_price_matched: number | null;
  supplier_price_is_manual: boolean; profit: number | null; ros: number | null; roi: number | null;
}

// ─── хелперы ───────────────────────────────────────────────────────────────────

function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function today() { return new Date().toISOString().slice(0, 10); }
function fmtRub(v: number | null | undefined) { return v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽'; }
function fmtPct(v: number | null | undefined) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }

function recalcMetrics(o: OrderRow, price: number | null): Partial<OrderRow> {
  const profit = price != null && o.revenue > 0 ? Math.round((o.revenue - o.fees_total - price) * 100) / 100 : null;
  const ros = profit != null && o.revenue > 0 ? Math.round(profit / o.revenue * 10000) / 10000 : null;
  const roi = profit != null && price != null && price > 0 ? Math.round(profit / price * 10000) / 10000 : null;
  return { supplier_price: price, supplier_price_is_manual: true, profit, ros, roi };
}

// ─── статусы ───────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['PROCESSING', 'READY_TO_SHIP', 'DELIVERY', 'PICKUP']);
const DONE_STATUSES = new Set(['DELIVERED', 'NONPICKUP', 'RETURNED']);

const YM_STATUS_CFG: Record<string, { label: string; bg: string; color: string }> = {
  PROCESSING:    { label: 'В сборке',   bg: '#fef3c7', color: '#92400e' },
  READY_TO_SHIP: { label: 'К отгрузке', bg: '#fef3c7', color: '#92400e' },
  DELIVERY:      { label: 'В доставке', bg: '#dbeafe', color: '#1d4ed8' },
  PICKUP:        { label: 'В ПВЗ',      bg: '#dbeafe', color: '#1d4ed8' },
  DELIVERED:     { label: 'Доставлен',  bg: '#dcfce7', color: '#166534' },
  NONPICKUP:     { label: 'Невыкуп',    bg: '#fef9c3', color: '#713f12' },
  RETURNED:      { label: 'Возврат',    bg: '#fee2e2', color: '#991b1b' },
  CANCELLED:     { label: 'Отменён',    bg: '#f3f4f6', color: '#6b7280' },
};

const FEE_COLORS: Record<string, string> = {
  FEE:    '#6b7280',
  FIXED:  '#6b7280',
  TAX:    '#7c3aed',
  SUBSIDY:'#16a34a',
  BONUS:  '#dc2626',
};

function getRowStyle(o: OrderRow): React.CSSProperties {
  const s = o.ym_status;
  if (s && ACTIVE_STATUSES.has(s)) return {};
  if (o.order_kind === 'nonpickup') return { opacity: 0.55 };
  if (o.order_kind === 'return') return { background: '#fff1f2' };
  return { opacity: 0.65 };
}

// ─── столбцы ───────────────────────────────────────────────────────────────────

const COL_KEYS = ['date','orderid','qty','status','store','sku','product','price','plan','fact','serial','diff','profit','ros','roi','calc','paydate','turnover','expand'] as const;
type ColKey = typeof COL_KEYS[number];

const COL_META: { key: ColKey; label: string; defaultOn: boolean; alwaysOn?: boolean }[] = [
  { key: 'date',     label: 'Дата отгрузки',    defaultOn: true },
  { key: 'orderid',  label: '№ Заказа',          defaultOn: true },
  { key: 'qty',      label: 'Кол-во',            defaultOn: true },
  { key: 'status',   label: 'Статус',            defaultOn: true },
  { key: 'store',    label: 'Магазин',           defaultOn: true },
  { key: 'sku',      label: 'SKU',               defaultOn: false },
  { key: 'product',  label: 'Товар',             defaultOn: true, alwaysOn: true },
  { key: 'price',    label: 'Цена продажи',      defaultOn: true },
  { key: 'plan',     label: 'План закуп',        defaultOn: true },
  { key: 'fact',     label: 'Факт закуп',        defaultOn: true },
  { key: 'serial',   label: 'Серийный номер',    defaultOn: false },
  { key: 'diff',     label: 'Разница план/факт', defaultOn: false },
  { key: 'profit',   label: 'Прибыль',           defaultOn: true },
  { key: 'ros',      label: 'ROS',               defaultOn: true },
  { key: 'roi',      label: 'ROI',               defaultOn: true },
  { key: 'calc',     label: 'Расчёт',            defaultOn: true },
  { key: 'paydate',  label: 'Дата выплаты',      defaultOn: false },
  { key: 'turnover', label: 'Оборот (дней)',      defaultOn: true },
  { key: 'expand',   label: '',                  defaultOn: true, alwaysOn: true },
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  date: 90, orderid: 115, qty: 55, status: 105, store: 90, sku: 130,
  product: 200, price: 100, plan: 90, fact: 100, serial: 130, diff: 100,
  profit: 90, ros: 65, roi: 65, calc: 85, paydate: 100, turnover: 90, expand: 36,
};

const LS_WIDTHS = 'orders_col_widths_v2';
const LS_VISIBLE = 'orders_visible_cols_v1';

function loadWidths(): Record<ColKey, number> {
  try { const s = localStorage.getItem(LS_WIDTHS); if (s) return { ...DEFAULT_WIDTHS, ...JSON.parse(s) }; } catch { /**/ }
  return { ...DEFAULT_WIDTHS };
}

function loadVisible(): Set<ColKey> {
  try {
    const s = localStorage.getItem(LS_VISIBLE);
    if (s) return new Set(JSON.parse(s) as ColKey[]);
  } catch { /**/ }
  return new Set(COL_META.filter(c => c.defaultOn).map(c => c.key));
}

// ─── сортировка ────────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

function turnoverDays(o: OrderRow): number | null {
  if (!o.shipment_date || !o.payment_date) return null;
  const a = new Date(o.shipment_date).getTime();
  const b = new Date(o.payment_date).getTime();
  return Math.round((b - a) / 86400000);
}

const SORT_FN: Partial<Record<ColKey, (o: OrderRow) => number | string>> = {
  date:     o => o.order_date ?? '',
  orderid:  o => o.order_id,
  qty:      o => o.quantity ?? 1,
  store:    o => o.store_name,
  product:  o => o.offer_name ?? '',
  price:    o => o.revenue,
  plan:     o => o.supplier_price_matched ?? 0,
  fact:     o => o.supplier_price_is_manual ? (o.supplier_price ?? 0) : 0,
  serial:   o => o.serial_number ?? '',
  profit:   o => o.profit ?? -Infinity,
  ros:      o => o.ros ?? -Infinity,
  roi:      o => o.roi ?? -Infinity,
  paydate:  o => o.payment_date ?? '',
  turnover: o => turnoverDays(o) ?? -Infinity,
};

// ─── ResizableTh ───────────────────────────────────────────────────────────────

function ResizableTh({ colKey, widths, onResize, sortCol, onSort, children, style }: {
  colKey: ColKey; widths: Record<ColKey, number>;
  onResize: (col: ColKey, x: number, w: number) => void;
  sortCol: ColKey | null; sortDir?: SortDir; onSort: (col: ColKey) => void;
  children?: React.ReactNode; style?: React.CSSProperties;
}) {
  const sortable = colKey in SORT_FN;
  return (
    <th className="th" style={{ width: widths[colKey], minWidth: widths[colKey], maxWidth: widths[colKey], position: 'relative', userSelect: 'none', overflow: 'hidden', cursor: sortable ? 'pointer' : 'default', ...style }}
      onClick={sortable ? () => onSort(colKey) : undefined}>
      <span style={{ color: sortCol === colKey ? '#2563eb' : undefined }}>{children}</span>
      <div onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onResize(colKey, e.clientX, widths[colKey]); }}
        style={{ position: 'absolute', right: 0, top: '20%', bottom: '20%', width: 3, cursor: 'col-resize', zIndex: 1, background: '#d1d5db', borderRadius: 2, transition: 'background 0.15s' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#6b7280')}
        onMouseLeave={e => (e.currentTarget.style.background = '#d1d5db')}
      />
    </th>
  );
}

// ─── FactSupplierCell ──────────────────────────────────────────────────────────

function FactSupplierCell({ row, onUpdated }: { row: OrderRow; onUpdated: (id: number, price: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.supplier_price != null ? String(row.supplier_price) : '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const parsed = value.trim() === '' ? null : parseFloat(value.replace(',', '.'));
    try { await updateOrderSupplierPrice(row.store_id, row.id, parsed); onUpdated(row.id, parsed); setEditing(false); } catch { /**/ }
    setSaving(false);
  }

  if (editing) return (
    <td className="td" style={{ textAlign: 'right', background: '#fef9c3' }}>
      <input autoFocus value={value} onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ width: 70, padding: '2px 4px', border: '1px solid #2563eb', borderRadius: 4, fontSize: 12, textAlign: 'right' }} />
      <button onClick={save} disabled={saving} style={{ marginLeft: 3, padding: '2px 5px', fontSize: 11, borderRadius: 4, border: 'none', background: '#16a34a', color: 'white', cursor: 'pointer' }}>✓</button>
      <button onClick={() => setEditing(false)} style={{ marginLeft: 2, padding: '2px 5px', fontSize: 11, borderRadius: 4, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>✕</button>
    </td>
  );

  const needsInput = !row.supplier_price_is_manual;
  return (
    <td className="td" onClick={() => setEditing(true)} title={needsInput ? 'Введите фактический закуп' : 'Нажмите для редактирования'}
      style={{ textAlign: 'right', cursor: 'pointer', background: needsInput ? '#fef9c3' : undefined, color: needsInput ? '#92400e' : undefined }}>
      {row.supplier_price_is_manual ? fmtRub(row.supplier_price) : <span style={{ color: '#d97706', fontWeight: 500 }}>+ ввести</span>}
    </td>
  );
}

// ─── SerialNumberCell ──────────────────────────────────────────────────────────

function SerialNumberCell({ row, onUpdated }: { row: OrderRow; onUpdated: (id: number, val: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.serial_number ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const v = value.trim() || null;
    try { await updateOrderSerialNumber(row.store_id, row.id, v); onUpdated(row.id, v); setEditing(false); } catch { /**/ }
    setSaving(false);
  }

  if (editing) return (
    <td className="td">
      <input autoFocus value={value} onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ width: 90, padding: '2px 4px', border: '1px solid #2563eb', borderRadius: 4, fontSize: 12 }} />
      <button onClick={save} disabled={saving} style={{ marginLeft: 3, padding: '2px 5px', fontSize: 11, borderRadius: 4, border: 'none', background: '#16a34a', color: 'white', cursor: 'pointer' }}>✓</button>
      <button onClick={() => setEditing(false)} style={{ marginLeft: 2, padding: '2px 5px', fontSize: 11, borderRadius: 4, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>✕</button>
    </td>
  );

  return (
    <td className="td" onClick={() => setEditing(true)} title="Нажмите для редактирования" style={{ cursor: 'pointer', color: row.serial_number ? '#374151' : '#d1d5db', fontSize: 12 }}>
      {row.serial_number ?? <span style={{ color: '#d1d5db' }}>—</span>}
    </td>
  );
}

// ─── компоненты аналитики магазина ─────────────────────────────────────────────

const TOOLTIP_STYLE = {
  background: '#1f2937', border: 'none', borderRadius: '8px', color: 'white', fontSize: '13px',
};

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const revenue = payload.find((p: any) => p.dataKey === 'revenue');
  const profit = payload.find((p: any) => p.dataKey === 'profit');
  const fees = payload.find((p: any) => p.dataKey === 'fees');
  const count = payload[0]?.payload?.count;
  return (
    <div style={TOOLTIP_STYLE}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #374151', fontWeight: 600 }}>{label}</div>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {revenue && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: revenue.color }}>Выручка</span><span>{fmtRub(revenue.value)}</span></div>}
        {profit && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: profit.color }}>Прибыль</span><span>{fmtRub(profit.value)}</span></div>}
        {fees && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}><span style={{ color: fees.color }}>Комиссии</span><span>{fmtRub(fees.value)}</span></div>}
        {count != null && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, borderTop: '1px solid #374151', paddingTop: 4, marginTop: 2 }}><span style={{ color: '#9ca3af' }}>Заказов</span><span>{count}</span></div>}
      </div>
    </div>
  );
}

function SalesChart({ data }: { data: DailyStats[] }) {
  if (!data.length) return <div style={{ color: '#6b7280', textAlign: 'center', padding: '32px' }}>Нет данных для графика</div>;
  const chartData = data.map(d => ({
    date: d.date.slice(5).split('-').reverse().join('.'),
    revenue: Math.round(d.revenue),
    profit: Math.round(d.profit),
    fees: Math.round(d.fees),
    count: d.count,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="salesRevenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="salesProfit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false}
          tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}к` : v} />
        <Tooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
        <Area type="monotone" dataKey="revenue" name="Выручка" stroke="#3b82f6" strokeWidth={2} fill="url(#salesRevenue)" dot={false} activeDot={{ r: 4 }} />
        <Area type="monotone" dataKey="profit" name="Прибыль" stroke="#22c55e" strokeWidth={2} fill="url(#salesProfit)" dot={false} activeDot={{ r: 4 }} />
        <Area type="monotone" dataKey="fees" name="Комиссии" stroke="#f59e0b" strokeWidth={1.5} fill="none" dot={false} activeDot={{ r: 4 }} strokeDasharray="4 4" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SummaryCards({ summary }: { summary: OrdersSummary }) {
  const cards = [
    { label: 'Заказов (продаж)', value: String(summary.total_orders) },
    { label: 'Выручка (с субсидиями)', value: fmtRub(summary.total_revenue) },
    { label: 'Комиссии ЯМ', value: fmtRub(summary.total_fees) },
    { label: 'Налоги (УСН)', value: fmtRub(summary.total_tax) },
    { label: 'Закупочная стоимость', value: fmtRub(summary.total_supplier_cost) },
    { label: 'Прибыль', value: fmtRub(summary.total_profit), highlight: summary.total_profit != null && summary.total_profit < 0 ? 'red' : 'green' },
    { label: 'ROI', value: summary.roi != null ? `${(summary.roi * 100).toFixed(1)}%` : '—', highlight: summary.roi != null && summary.roi < 0 ? 'red' : undefined },
  ];
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
        {cards.map((c) => (
          <div key={c.label} className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: c.highlight === 'red' ? '#ef4444' : c.highlight === 'green' ? '#16a34a' : '#111827' }}>{c.value}</div>
          </div>
        ))}
      </div>
      {(summary.nonpickup_count > 0 || summary.return_count > 0) && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="card" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Невыкупов за период:</span>
            <span style={{ fontWeight: 600, color: '#f59e0b' }}>{summary.nonpickup_count}</span>
            {summary.nonpickup_pct != null && <span style={{ fontSize: 13, color: '#f59e0b' }}>({fmtPct(summary.nonpickup_pct)})</span>}
          </div>
          <div className="card" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Возвратов за период:</span>
            <span style={{ fontWeight: 600, color: '#ef4444' }}>{summary.return_count}</span>
            {summary.return_pct != null && <span style={{ fontSize: 13, color: '#ef4444' }}>({fmtPct(summary.return_pct)})</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ReceivablesBlock({ data, loading, error }: { data: Receivables; loading: boolean; error: string | null }) {
  const tdL: React.CSSProperties = { padding: '10px 16px', color: '#374151', fontSize: 14 };
  const tdR: React.CSSProperties = { padding: '10px 16px', textAlign: 'right', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' };
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 24 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 14 }}>Дебиторская задолженность маркетплейса</div>
      {loading && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Загрузка из ЯМ...</div>}
      {error && <div style={{ padding: 16, color: '#991b1b', fontSize: 13 }}>{error}</div>}
      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={tdL}>По всем заказам</td>
              <td style={tdR}>{fmtRub(data.total)}</td>
            </tr>
            <tr>
              <td style={tdL}>С индексацией на возвраты и невыкупы</td>
              <td style={tdR}>{fmtRub(data.adjusted)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── страница ───────────────────────────────────────────────────────────────────

type CompletionFilter = 'all' | 'completed' | 'active';

export default function OrdersListPage() {
  const { storeId } = useParams<{ storeId?: string }>();
  const isStoreView = Boolean(storeId);
  const numericStoreId = storeId
    ? (storeId === 'yam16' ? 1 : storeId === 'yam21' ? 2 : Number(storeId))
    : null;

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(daysAgo(60));
  const [dateTo, setDateTo] = useState(today());

  // аналитика магазина
  const [summary, setSummary] = useState<OrdersSummary | null>(null);
  const [receivables, setReceivables] = useState<Receivables | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(false);
  const [receivablesError, setReceivablesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [filterStores, setFilterStores] = useState<Set<string>>(new Set());
  const [showStorePicker, setShowStorePicker] = useState(false);
  const storePickerRef = useRef<HTMLDivElement>(null);
  const [filterCompletion, setFilterCompletion] = useState<CompletionFilter>('all');
  const [colWidths, setColWidths] = useState<Record<ColKey, number>>(loadWidths);
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(loadVisible);
  const [showColPicker, setShowColPicker] = useState(false);
  const [sortCol, setSortCol] = useState<ColKey | null>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const resizeRef = useRef<{ col: ColKey; startX: number; startW: number } | null>(null);
  const colPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { localStorage.setItem(LS_WIDTHS, JSON.stringify(colWidths)); }, [colWidths]);
  useEffect(() => { localStorage.setItem(LS_VISIBLE, JSON.stringify([...visibleCols])); }, [visibleCols]);

  // Закрыть picker при клике снаружи
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) setShowColPicker(false);
      if (storePickerRef.current && !storePickerRef.current.contains(e.target as Node)) setShowStorePicker(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function startResize(col: ColKey, startX: number, startW: number) {
    resizeRef.current = { col, startX, startW };
    function onMove(e: MouseEvent) {
      if (!resizeRef.current) return;
      setColWidths(prev => ({ ...prev, [resizeRef.current!.col]: Math.max(40, resizeRef.current!.startW + e.clientX - resizeRef.current!.startX) }));
    }
    function onUp() { resizeRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function toggleSort(col: ColKey) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  function toggleCol(key: ColKey) {
    setVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function load() {
    setLoading(true); setError(null);
    try { await syncActiveOrders(); } catch { /**/ }
    const qs = new URLSearchParams({ limit: '500', date_from: dateFrom, date_to: dateTo });
    const url = isStoreView ? `/stores/${numericStoreId}/orders?${qs}` : `/orders?${qs}`;
    try {
      const data = await apiFetch<OrderRow[]>(url);
      setOrders(data);
      if (isStoreView && data.length > 0) {
        setFilterStores(new Set([data[0].store_name]));
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
    // Для аналитики магазина: загружаем сводку
    if (isStoreView && numericStoreId) {
      fetchOrdersSummary(numericStoreId, dateFrom, dateTo).then(setSummary).catch(() => {});
    }
  }

  function loadReceivables() {
    if (!isStoreView || !numericStoreId) return;
    setReceivablesLoading(true);
    setReceivablesError(null);
    fetchReceivables(numericStoreId)
      .then(r => setReceivables(r))
      .catch(e => setReceivablesError(e.message))
      .finally(() => setReceivablesLoading(false));
  }

  async function handleSync() {
    if (!numericStoreId) return;
    setSyncing(true); setSyncMsg(null); setError(null);
    try {
      const res = await syncOrders(numericStoreId, dateFrom, dateTo);
      setSyncMsg(`Синхронизация завершена: добавлено ${res.added} строк`);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => { load(); }, [dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (isStoreView) loadReceivables(); }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleExpand(id: number) { setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function handleSupplierUpdated(id: number, price: number | null) { setOrders(prev => prev.map(o => o.id === id ? { ...o, ...recalcMetrics(o, price) } : o)); }
  function handleSerialUpdated(id: number, val: string | null) { setOrders(prev => prev.map(o => o.id === id ? { ...o, serial_number: val } : o)); }

  const storeOptions = useMemo(() => [...new Set(orders.map(o => o.store_name).filter(Boolean))].sort(), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = orders.filter(o => {
      if (filterStores.size > 0 && !filterStores.has(o.store_name)) return false;
      if (q && ![(o.offer_name ?? ''), (o.sku ?? ''), o.order_id].some(s => s.toLowerCase().includes(q))) return false;
      if (filterCompletion === 'completed' && !DONE_STATUSES.has(o.ym_status ?? '')) return false;
      if (filterCompletion === 'active' && !ACTIVE_STATUSES.has(o.ym_status ?? '')) return false;
      return true;
    });
    if (sortCol && SORT_FN[sortCol]) {
      const fn = SORT_FN[sortCol]!;
      rows = [...rows].sort((a, b) => {
        const av = fn(a), bv = fn(b);
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [orders, search, filterStores, filterCompletion, sortCol, sortDir]);

  const totals = useMemo(() => {
    const revenue = filtered.reduce((s, o) => s + (o.revenue || 0), 0);
    const planSum = filtered.reduce((s, o) => s + (o.supplier_price_matched ?? (!o.supplier_price_is_manual ? (o.supplier_price || 0) : 0)), 0);
    const factRows = filtered.filter(o => o.supplier_price_is_manual);
    const factSum = factRows.reduce((s, o) => s + (o.supplier_price || 0), 0);
    const profitRows = filtered.filter(o => o.profit != null);
    const profitSum = profitRows.reduce((s, o) => s + (o.profit ?? 0), 0);
    const turnoverRows = filtered.map(o => turnoverDays(o)).filter((d): d is number => d != null);
    const avgTurnover = turnoverRows.length > 0 ? Math.round(turnoverRows.reduce((s, d) => s + d, 0) / turnoverRows.length) : null;
    return {
      count: filtered.length,
      normal: filtered.filter(o => o.order_kind === 'normal').length,
      nonpickup: filtered.filter(o => o.order_kind === 'nonpickup').length,
      ret: filtered.filter(o => o.order_kind === 'return').length,
      revenue, planSum, factSum, factCount: factRows.length,
      profitSum, profitHasData: profitRows.length > 0,
      rosAgg: revenue > 0 ? profitSum / revenue : null,
      roiAgg: factSum > 0 ? profitSum / factSum : null,
      avgTurnover,
    };
  }, [filtered]);

  // Экспорт XLS
  function exportXls() {
    const visKeys = COL_KEYS.filter(k => k !== 'expand' && visibleCols.has(k));
    const LABELS: Record<ColKey, string> = {
      date: 'Дата отгрузки', orderid: '№ Заказа', qty: 'Кол-во', status: 'Статус',
      store: 'Магазин', sku: 'SKU', product: 'Товар', price: 'Цена продажи',
      plan: 'План закуп', fact: 'Факт закуп', serial: 'Серийный номер', diff: 'Разница план/факт',
      profit: 'Прибыль', ros: 'ROS %', roi: 'ROI %', calc: 'Расчёт',
      paydate: 'Дата выплаты', turnover: 'Оборот (дней)', expand: '',
    };
    const getVal = (o: OrderRow, k: ColKey): string | number => {
      const plan = o.supplier_price_matched ?? (!o.supplier_price_is_manual ? (o.supplier_price ?? '') : '');
      const fact = o.supplier_price_is_manual ? (o.supplier_price ?? '') : '';
      switch (k) {
        case 'date': return o.order_date ? o.order_date.split('-').reverse().join('.') : '';
        case 'orderid': return o.order_id;
        case 'qty': return o.quantity ?? 1;
        case 'status': return o.ym_status ? (YM_STATUS_CFG[o.ym_status]?.label ?? o.ym_status) : '';
        case 'store': return o.store_name;
        case 'sku': return o.sku ?? '';
        case 'product': return o.offer_name ?? '';
        case 'price': return o.revenue;
        case 'plan': return typeof plan === 'number' ? plan : '';
        case 'fact': return typeof fact === 'number' ? fact : '';
        case 'diff': return (typeof fact === 'number' && typeof plan === 'number') ? fact - plan : '';
        case 'serial': return o.serial_number ?? '';
        case 'profit': return o.profit ?? '';
        case 'ros': return o.ros != null ? +((o.ros * 100).toFixed(1)) : '';
        case 'roi': return o.roi != null ? +((o.roi * 100).toFixed(1)) : '';
        case 'calc': return o.order_kind === 'normal' ? (o.is_forecast ? 'Прогнозн.' : 'Факт') : '';
        case 'paydate': return o.payment_date ? o.payment_date.split('-').reverse().join('.') : '';
        case 'turnover': return turnoverDays(o) ?? '';
        default: return '';
      }
    };
    const esc = (v: unknown) => { const s = String(v ?? ''); return s.includes('\t') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [visKeys.map(k => LABELS[k]), ...filtered.map(o => visKeys.map(k => getVal(o, k))), [], visKeys.map(k => {
      switch (k) {
        case 'orderid': return `${totals.count} заказов`;
        case 'price': return totals.revenue;
        case 'plan': return totals.planSum;
        case 'fact': return totals.factSum;
        case 'profit': return totals.profitHasData ? totals.profitSum : '';
        case 'ros': return totals.rosAgg != null ? +((totals.rosAgg * 100).toFixed(1)) : '';
        case 'roi': return totals.roiAgg != null ? +((totals.roiAgg * 100).toFixed(1)) : '';
        default: return '';
      }
    })];
    const tsv = rows.map(r => r.map(esc).join('\t')).join('\n');
    const blob = new Blob(['\ufeff' + tsv], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `orders_${today()}.xls` });
    a.click(); URL.revokeObjectURL(a.href);
  }

  // Активные видимые столбцы в порядке COL_KEYS
  const activeCols = COL_KEYS.filter(k => visibleCols.has(k));
  const COL_COUNT = activeCols.length;

  const th = (colKey: ColKey, label: string, style?: React.CSSProperties) => (
    <ResizableTh key={colKey} colKey={colKey} widths={colWidths} onResize={startResize}
      sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} style={style}>
      {label}
    </ResizableTh>
  );

  const COL_HEADERS: Record<ColKey, () => React.ReactNode> = {
    date:     () => th('date', 'Дата отгрузки'),
    orderid:  () => th('orderid', '№ Заказа'),
    qty:      () => th('qty', 'Кол-во', { textAlign: 'center' }),
    status:   () => th('status', 'Статус'),
    store:    () => th('store', 'Магазин'),
    sku:      () => th('sku', 'SKU'),
    product:  () => th('product', 'Товар'),
    price:    () => th('price', 'Цена продажи', { textAlign: 'right' }),
    plan:     () => th('plan', 'План закуп', { textAlign: 'right' }),
    fact:     () => th('fact', 'Факт закуп ✎', { textAlign: 'right' }),
    serial:   () => th('serial', 'Серийный №  ✎'),
    diff:     () => th('diff', 'Разница', { textAlign: 'right' }),
    profit:   () => th('profit', 'Прибыль', { textAlign: 'right' }),
    ros:      () => th('ros', 'ROS', { textAlign: 'right' }),
    roi:      () => th('roi', 'ROI', { textAlign: 'right' }),
    calc:     () => th('calc', 'Расчёт'),
    paydate:  () => th('paydate', 'Дата выплаты'),
    turnover: () => th('turnover', 'Оборот, дн.', { textAlign: 'right' }),
    expand:   () => <ResizableTh key="expand" colKey="expand" widths={colWidths} onResize={startResize} sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />,
  };

  // Стиль строки итогов
  const tf: React.CSSProperties = {
    fontWeight: 700,
    fontSize: 13,
    background: '#dde3ea',
    borderTop: '2px solid #c4cdd6',
    borderRight: '1px solid #c4cdd6',
    whiteSpace: 'nowrap',
    padding: '9px 10px',
  };
  const pc = totals.profitSum >= 0 ? '#166534' : '#ef4444';
  const FOOT: Record<ColKey, () => React.ReactNode> = {
    date:    () => <td key="date" style={{ ...tf, fontWeight: 800, letterSpacing: '0.05em' }}>ИТОГО</td>,
    orderid: () => <td key="orderid" style={tf} />,
    qty:     () => <td key="qty" style={{ ...tf, color: '#374151', textAlign: 'center' }}>{totals.count}</td>,
    status:  () => <td key="status" style={tf} />,
    store:   () => <td key="store" style={tf} />,
    sku:     () => <td key="sku" style={tf} />,
    product: () => <td key="product" style={tf} />,
    price:   () => <td key="price" style={{ ...tf, textAlign: 'right' }}>{fmtRub(totals.revenue)}</td>,
    plan:    () => <td key="plan" style={{ ...tf, textAlign: 'right', color: '#6b7280' }}>{fmtRub(totals.planSum)}</td>,
    fact:     () => <td key="fact" style={{ ...tf, textAlign: 'right', color: totals.factCount < totals.count ? '#d97706' : '#374151' }}>{fmtRub(totals.factSum)}</td>,
    serial:   () => <td key="serial" style={tf} />,
    diff:     () => <td key="diff" style={tf} />,
    profit:   () => <td key="profit" style={{ ...tf, textAlign: 'right', color: totals.profitHasData ? pc : '#9ca3af' }}>{totals.profitHasData ? fmtRub(totals.profitSum) : '—'}</td>,
    ros:      () => <td key="ros" style={{ ...tf, textAlign: 'right', color: totals.rosAgg == null ? '#9ca3af' : totals.rosAgg >= 0 ? '#16a34a' : '#ef4444' }}>{fmtPct(totals.rosAgg)}</td>,
    roi:      () => <td key="roi" style={{ ...tf, textAlign: 'right', color: totals.roiAgg == null ? '#9ca3af' : totals.roiAgg >= 0 ? '#16a34a' : '#ef4444' }}>{fmtPct(totals.roiAgg)}</td>,
    calc:     () => <td key="calc" style={tf} />,
    paydate:  () => <td key="paydate" style={tf} />,
    turnover: () => <td key="turnover" style={{ ...tf, textAlign: 'right' }}>{totals.avgTurnover != null ? `≈ ${totals.avgTurnover} дн.` : '—'}</td>,
    expand:   () => <td key="expand" style={tf} />,
  };

  return (
    <div>
      {/* Шапка */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>
          {isStoreView && orders.length > 0 ? `Аналитика — ${orders[0].store_name}` : 'Продажи'}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isStoreView && (
            <button className="button" onClick={handleSync} disabled={syncing} style={{ whiteSpace: 'nowrap' }}>
              {syncing ? 'Загрузка из ЯМ...' : 'Синхронизировать из ЯМ'}
            </button>
          )}
          <button className="button" onClick={load} disabled={loading}>{loading ? 'Загрузка...' : 'Обновить'}</button>
        </div>
      </div>

      {syncMsg && <div style={{ background: '#d1fae5', color: '#065f46', padding: '10px 16px', borderRadius: 8, marginBottom: 16 }}>{syncMsg}</div>}

      {/* Аналитический блок — только для страницы магазина */}
      {isStoreView && summary && <SummaryCards summary={summary} />}
      {isStoreView && summary && summary.daily.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>Динамика по дням</div>
          <SalesChart data={summary.daily} />
        </div>
      )}
      {isStoreView && summary && summary.matched_orders < summary.total_orders && (
        <div style={{ background: '#fef3c7', color: '#92400e', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
          Закупочная стоимость найдена только для {summary.matched_orders} из {summary.total_orders} заказов.
        </div>
      )}
      {isStoreView && (
        <ReceivablesBlock
          data={receivables ?? { total: 0, adjusted: 0, nonpickup_pct: 0, return_pct: 0 }}
          loading={receivablesLoading}
          error={receivablesError}
        />
      )}

      {/* Фильтры в одну строку */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Даты */}
        <label style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
          С&nbsp;<input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
          По&nbsp;<input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        </label>
        {/* поиск */}
        <input
          type="text"
          placeholder="SKU, наименование, номер"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="select-input"
          style={{ width: 240, backgroundImage: 'none', paddingRight: 12, cursor: 'text' }}
        />
        {/* Мультивыбор магазинов — скрыт при просмотре конкретного магазина */}
        {!isStoreView && <div ref={storePickerRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setShowStorePicker(v => !v)}
            className="select-input"
            style={{ cursor: 'pointer', minWidth: 130, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <span>{filterStores.size === 0 ? 'Все магазины' : [...filterStores].join(', ')}</span>
            <span style={{ color: '#9ca3af', fontSize: 10 }}>▾</span>
          </button>
          {showStorePicker && (
            <div style={{ position: 'absolute', left: 0, top: '110%', zIndex: 100, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '8px 0', minWidth: 160 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', cursor: 'pointer', fontSize: 13, color: '#6b7280' }}>
                <input type="checkbox" checked={filterStores.size === 0} onChange={() => setFilterStores(new Set())} />
                Все магазины
              </label>
              {storeOptions.map(s => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', cursor: 'pointer', fontSize: 13, color: '#374151' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'white')}>
                  <input type="checkbox" checked={filterStores.has(s)} onChange={() => {
                    setFilterStores(prev => {
                      const next = new Set(prev);
                      next.has(s) ? next.delete(s) : next.add(s);
                      return next;
                    });
                  }} />
                  {s}
                </label>
              ))}
            </div>
          )}
        </div>}
        <select className="select-input" value={filterCompletion} onChange={e => setFilterCompletion(e.target.value as CompletionFilter)}>
          <option value="all">Все заказы</option>
          <option value="completed">Только завершённые</option>
          <option value="active">Только отгруженные</option>
        </select>
        {(search || filterStores.size > 0 || filterCompletion !== 'all') && (
          <button onClick={() => { setSearch(''); setFilterStores(new Set()); setFilterCompletion('all'); }}
            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', color: '#6b7280' }}>
            Сбросить
          </button>
        )}
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{filtered.length} из {orders.length}</span>

        {/* Технические кнопки — менее заметные */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Выбор столбцов */}
          <div ref={colPickerRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowColPicker(v => !v)}
              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer', color: '#9ca3af' }}>
              Столбцы ▾
            </button>
            {showColPicker && (
              <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 100, background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '8px 0', minWidth: 200 }}>
                {COL_META.filter(c => !c.alwaysOn && c.key !== 'expand').map(c => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', cursor: 'pointer', fontSize: 13, color: '#374151' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'white')}>
                    <input type="checkbox" checked={visibleCols.has(c.key)} onChange={() => toggleCol(c.key)} style={{ cursor: 'pointer' }} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={exportXls}
            style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer', color: '#9ca3af' }}>
            ↓ XLS
          </button>
        </div>
      </div>

      {loading && <LoadingCats />}
      {error && <div style={{ color: '#dc2626', padding: '10px 16px', background: '#fee2e2', borderRadius: 8, marginBottom: 16 }}>{error}</div>}

      {!loading && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
            <table className="table" style={{ tableLayout: 'fixed' }}>
              <colgroup>{activeCols.map(k => <col key={k} style={{ width: colWidths[k] }} />)}</colgroup>
              <thead>
                <tr>{activeCols.map(k => COL_HEADERS[k]())}</tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={COL_COUNT} className="td" style={{ textAlign: 'center', color: '#9ca3af', padding: 32 }}>
                    {orders.length === 0 ? 'Нет заказов за выбранный период' : 'Нет совпадений'}
                  </td></tr>
                )}
                {filtered.map(o => {
                  const rowStyle = getRowStyle(o);
                  const needsInput = !o.supplier_price_is_manual;
                  const isExp = expanded.has(o.id);
                  const hasFees = o.fee_details && o.fee_details.length > 0;
                  const profitColor = o.profit == null ? '#9ca3af' : o.profit >= 0 ? '#16a34a' : '#ef4444';
                  const statusCfg = o.ym_status ? YM_STATUS_CFG[o.ym_status] : null;
                  const finalBg = needsInput && !rowStyle.background ? '#fffbeb' : rowStyle.background;
                  const planVal = o.supplier_price_matched ?? (!o.supplier_price_is_manual ? o.supplier_price : null);
                  const factVal = o.supplier_price_is_manual ? o.supplier_price : null;
                  const diffVal = factVal != null && planVal != null ? factVal - planVal : null;

                  const CELLS: Record<ColKey, () => React.ReactNode> = {
                    date:    () => <td key="date" className="td" style={{ fontSize: 13, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{o.order_date ? o.order_date.split('-').reverse().join('.') : '—'}</td>,
                    orderid: () => <td key="orderid" className="td" style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{o.order_id}</td>,
                    qty:     () => <td key="qty" className="td" style={{ textAlign: 'center', fontWeight: 500, color: '#374151', cursor: hasFees ? 'pointer' : undefined }}>{o.quantity ?? 1}</td>,
                    status:  () => <td key="status" className="td" style={{ overflow: 'hidden', cursor: hasFees ? 'pointer' : undefined }}>{statusCfg && <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: statusCfg.bg, color: statusCfg.color, whiteSpace: 'nowrap' }}>{statusCfg.label}</span>}</td>,
                    store:   () => <td key="store" className="td" style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{o.store_name}</td>,
                    sku:     () => <td key="sku" className="td" style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{o.sku ?? '—'}</td>,
                    product: () => <td key="product" className="td" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }} title={(o.offer_name ?? '') + (o.sku ? ` [${o.sku}]` : '')}>{o.offer_name || o.sku || '—'}</td>,
                    price:   () => <td key="price" className="td" style={{ textAlign: 'right', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{fmtRub(o.revenue)}</td>,
                    plan:    () => <td key="plan" className="td" style={{ textAlign: 'right', color: '#6b7280', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{fmtRub(planVal)}</td>,
                    fact:     () => <FactSupplierCell key="fact" row={o} onUpdated={handleSupplierUpdated} />,
                    serial:   () => <SerialNumberCell key="serial" row={o} onUpdated={handleSerialUpdated} />,
                    diff:     () => <td key="diff" className="td" style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 500, cursor: hasFees ? 'pointer' : undefined, color: diffVal == null ? '#9ca3af' : diffVal > 0 ? '#ef4444' : diffVal < 0 ? '#16a34a' : '#6b7280' }}>{diffVal == null ? '—' : fmtRub(diffVal)}</td>,
                    profit:   () => <td key="profit" className="td" style={{ textAlign: 'right', fontWeight: 600, color: profitColor, whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined }}>{fmtRub(o.profit)}</td>,
                    ros:      () => <td key="ros" className="td" style={{ textAlign: 'right', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined, color: o.ros == null ? '#9ca3af' : o.ros >= 0 ? '#16a34a' : '#ef4444' }}>{fmtPct(o.ros)}</td>,
                    roi:      () => <td key="roi" className="td" style={{ textAlign: 'right', whiteSpace: 'nowrap', cursor: hasFees ? 'pointer' : undefined, color: o.roi == null ? '#9ca3af' : o.roi >= 0 ? '#16a34a' : '#ef4444' }}>{fmtPct(o.roi)}</td>,
                    calc:     () => <td key="calc" className="td" style={{ cursor: hasFees ? 'pointer' : undefined }}>{o.order_kind === 'normal' && <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 500, background: o.is_forecast ? '#fef3c7' : '#dcfce7', color: o.is_forecast ? '#92400e' : '#166534' }}>{o.is_forecast ? 'Прогнозн.' : 'Факт'}</span>}</td>,
                    paydate:  () => <td key="paydate" className="td" style={{ fontSize: 12, color: '#4b5563', cursor: hasFees ? 'pointer' : undefined }}>{o.payment_date ? o.payment_date.split('-').reverse().join('.') : <span style={{ color: '#d1d5db' }}>—</span>}</td>,
                    turnover: () => { const d = turnoverDays(o); return <td key="turnover" className="td" style={{ textAlign: 'right', fontSize: 12, color: d == null ? '#d1d5db' : '#374151', cursor: hasFees ? 'pointer' : undefined }}>{d ?? '—'}</td>; },
                    expand:   () => <td key="expand" className="td" style={{ textAlign: 'center', padding: '4px 6px' }}>{hasFees && <span style={{ fontSize: 10, color: '#9ca3af' }}>{isExp ? '▲' : '▼'}</span>}</td>,
                  };

                  return (
                    <React.Fragment key={o.id}>
                      <tr
                        className="tr"
                        style={{ ...rowStyle, background: finalBg }}
                        onClick={hasFees ? (e) => {
                          // не разворачиваем при клике на ячейку ввода факт-закупа
                          const target = e.target as HTMLElement;
                          if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') return;
                          if (target.closest('td')?.querySelector('input')) return;
                          toggleExpand(o.id);
                        } : undefined}
                      >
                        {activeCols.map(k => CELLS[k]())}
                      </tr>
                      {isExp && hasFees && (
                        <tr>
                          <td colSpan={COL_COUNT} style={{ padding: '2px 0 6px 12px', background: '#f9fafb' }}>
                            <div style={{
                              display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0 0',
                              padding: '6px 10px', background: '#f1f5f9', borderRadius: 6, fontSize: 12,
                            }}>
                              {/* Детализация в одну строку */}
                              {o.fee_details.filter(d => d.type !== 'SUBSIDY').map((d, i) => (
                                <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3, paddingRight: 14, borderRight: '1px solid #e2e8f0', marginRight: 14, whiteSpace: 'nowrap' }}>
                                  <span style={{ color: FEE_COLORS[d.type] ?? '#6b7280' }}>{d.label}</span>
                                  <strong style={{ color: d.type === 'BONUS' ? '#dc2626' : '#374151' }}>
                                    {d.type === 'BONUS' ? '−' : ''}{d.amount.toLocaleString('ru-RU')} ₽
                                  </strong>
                                  <span style={{ color: '#9ca3af' }}>({d.pct.toFixed(1)}%)</span>
                                </span>
                              ))}
                              {/* Субсидия отдельно (зелёная, со знаком +) */}
                              {o.fee_details.filter(d => d.type === 'SUBSIDY').map((d, i) => (
                                <span key={`sub-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 3, paddingRight: 14, borderRight: '1px solid #e2e8f0', marginRight: 14, whiteSpace: 'nowrap' }}>
                                  <span style={{ color: '#16a34a' }}>{d.label}</span>
                                  <strong style={{ color: '#16a34a' }}>+{d.amount.toLocaleString('ru-RU')} ₽</strong>
                                </span>
                              ))}
                              {/* Итого сразу после комиссий */}
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                                {o.is_forecast && <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600, background: '#fef3c7', color: '#92400e' }}>Прогноз</span>}
                                <span style={{ color: '#6b7280' }}>Итого:</span>
                                <strong style={{ fontSize: 13 }}>{o.fees_total.toLocaleString('ru-RU')} ₽</strong>
                                {o.revenue > 0 && <span style={{ color: '#9ca3af' }}>({((o.fees_total / o.revenue) * 100).toFixed(1)}%)</span>}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>

              {/* Строка итогов — прилипает к низу */}
              <tfoot style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
                <tr>
                  {activeCols.map(k => FOOT[k]())}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
