import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { fetchOrders, fetchOrdersSummary, fetchReceivables, syncOrders, updateOrderSupplierPrice } from '../api/orders';
import type { DailyStats, Order, OrdersSummary, Receivables } from '../types/order';

// ---------- helpers ----------

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '—';
  return n.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return fmt(n) + ' ₽';
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return fmt(n * 100, 1) + '%';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function kindLabel(k: string): string {
  if (k === 'nonpickup') return 'Невыкуп';
  if (k === 'return') return 'Возврат';
  return 'Продажа';
}

function kindColor(k: string): string {
  if (k === 'nonpickup') return '#9ca3af';
  if (k === 'return') return '#ef4444';
  return '#22c55e';
}

// ---------- chart ----------

interface ChartProps {
  data: DailyStats[];
}

const TOOLTIP_STYLE = {
  background: '#1f2937', border: 'none', borderRadius: '8px', color: 'white', fontSize: '13px',
};

interface TooltipEntry { name: string; value: number; color: string; dataKey: string; payload: Record<string, unknown>; }
interface TooltipProps { active?: boolean; payload?: TooltipEntry[]; label?: string; }

function ChartTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const revenue = payload.find((p) => p.dataKey === 'revenue');
  const profit = payload.find((p) => p.dataKey === 'profit');
  const fees = payload.find((p) => p.dataKey === 'fees');
  const count = payload[0]?.payload?.count as number | undefined;
  return (
    <div style={TOOLTIP_STYLE}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #374151', fontWeight: 600 }}>{label}</div>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {revenue && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: revenue.color }}>Выручка</span>
          <span>{fmtMoney(revenue.value)}</span>
        </div>}
        {profit && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: profit.color }}>Прибыль</span>
          <span>{fmtMoney(profit.value)}</span>
        </div>}
        {fees && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: fees.color }}>Комиссии</span>
          <span>{fmtMoney(fees.value)}</span>
        </div>}
        {count != null && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, borderTop: '1px solid #374151', paddingTop: 4, marginTop: 2 }}>
          <span style={{ color: '#9ca3af' }}>Заказов</span>
          <span>{count}</span>
        </div>}
      </div>
    </div>
  );
}

function SalesChart({ data }: ChartProps) {
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
        <YAxis
          tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false}
          tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}к` : v}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '12px', paddingTop: '6px' }} />
        <Area type="monotone" dataKey="revenue" name="Выручка" stroke="#3b82f6" strokeWidth={2} fill="url(#salesRevenue)" dot={false} activeDot={{ r: 4 }} />
        <Area type="monotone" dataKey="profit" name="Прибыль" stroke="#22c55e" strokeWidth={2} fill="url(#salesProfit)" dot={false} activeDot={{ r: 4 }} />
        <Area type="monotone" dataKey="fees" name="Комиссии" stroke="#f59e0b" strokeWidth={1.5} fill="none" dot={false} activeDot={{ r: 4 }} strokeDasharray="4 4" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------- summary cards ----------

interface SummaryProps {
  summary: OrdersSummary;
}

function SummaryCards({ summary }: SummaryProps) {
  const cards = [
    { label: 'Заказов (продаж)', value: String(summary.total_orders) },
    { label: 'Выручка (с субсидиями)', value: fmtMoney(summary.total_revenue) },
    { label: 'Комиссии ЯМ', value: fmtMoney(summary.total_fees) },
    { label: 'Налоги (УСН)', value: fmtMoney(summary.total_tax) },
    { label: 'Закупочная стоимость', value: fmtMoney(summary.total_supplier_cost) },
    { label: 'Прибыль', value: fmtMoney(summary.total_profit), highlight: summary.total_profit != null && summary.total_profit < 0 ? 'red' : 'green' },
    { label: 'ROI', value: summary.roi != null ? `${(summary.roi * 100).toFixed(1)}%` : '—', highlight: summary.roi != null && summary.roi < 0 ? 'red' : undefined },
  ];

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
        {cards.map((c) => (
          <div key={c.label} className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{c.label}</div>
            <div style={{
              fontSize: 20, fontWeight: 600,
              color: c.highlight === 'red' ? '#ef4444' : c.highlight === 'green' ? '#16a34a' : '#111827',
            }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>
      {(summary.nonpickup_count > 0 || summary.return_count > 0) && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="card" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Невыкупов за период:</span>
            <span style={{ fontWeight: 600, color: '#f59e0b' }}>{summary.nonpickup_count}</span>
            {summary.nonpickup_pct != null && (
              <span style={{ fontSize: 13, color: '#f59e0b' }}>({fmtPct(summary.nonpickup_pct)})</span>
            )}
          </div>
          <div className="card" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Возвратов за период:</span>
            <span style={{ fontWeight: 600, color: '#ef4444' }}>{summary.return_count}</span>
            {summary.return_pct != null && (
              <span style={{ fontSize: 13, color: '#ef4444' }}>({fmtPct(summary.return_pct)})</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- receivables block ----------

interface ReceivablesProps {
  data: Receivables;
  loading: boolean;
  error: string | null;
}

function ReceivablesBlock({ data, loading, error }: ReceivablesProps) {
  const tdLabel: React.CSSProperties = { padding: '10px 16px', color: '#374151', fontSize: 14 };
  const tdValue: React.CSSProperties = { padding: '10px 16px', textAlign: 'right', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 24 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 14 }}>
        Дебиторская задолженность маркетплейса
      </div>
      {loading && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Загрузка из ЯМ...</div>}
      {error && <div style={{ padding: 16, color: '#991b1b', fontSize: 13 }}>{error}</div>}
      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={tdLabel}>По всем заказам</td>
              <td style={tdValue}>{fmtMoney(data.total)}</td>
            </tr>
            <tr>
              <td style={tdLabel}>С индексацией на возвраты и невыкупы</td>
              <td style={tdValue}>{fmtMoney(data.adjusted)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- helpers для таблиц ----------

// Прогнозный расчёт = нет фактических данных от ЯМ (all_services_fee == 0 или null)
function isForecast(o: Order): boolean {
  return o.order_kind === 'normal' && (!o.all_services_fee || o.all_services_fee === 0);
}

const FORECAST_BADGE = (
  <span style={{
    display: 'inline-block', marginLeft: 4, padding: '1px 5px', borderRadius: 3,
    fontSize: 10, fontWeight: 600, background: '#fef3c7', color: '#92400e',
    verticalAlign: 'middle', whiteSpace: 'nowrap',
  }}>
    Прогнозн.
  </span>
);

// ---------- orders table ----------

interface TableProps {
  orders: Order[];
}

function OrdersTable({ orders, storeId, onOrderUpdated }: TableProps & { storeId: number; onOrderUpdated: (id: number, price: number | null, isManual: boolean) => void }) {
  if (!orders.length) return <div style={{ color: '#6b7280', padding: 16 }}>Нет заказов за выбранный период</div>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
            {['Дата', 'Заказ', 'Товар', 'Вид', 'Выручка', 'Комиссии ЯМ', 'Закупка ✎', 'Прибыль'].map(h => (
              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', color: '#374151' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map(o => {
            const profit = o.profit;
            const forecast = isForecast(o);
            const missingSupplier = o.supplier_price == null;
            return (
              <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6', background: missingSupplier ? '#fffbeb' : undefined }}>
                <td style={{ padding: '7px 12px', whiteSpace: 'nowrap', color: '#6b7280' }}>
                  {o.order_date ? o.order_date.split('-').reverse().join('.') : '—'}
                </td>
                <td style={{ padding: '7px 12px', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }}>{o.order_id}</td>
                <td style={{ padding: '7px 12px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.offer_name ?? ''}>
                  {o.offer_name || '—'}
                </td>
                <td style={{ padding: '7px 12px' }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                    background: kindColor(o.order_kind) + '22', color: kindColor(o.order_kind),
                  }}>
                    {kindLabel(o.order_kind)}
                  </span>
                </td>
                <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(o.revenue ?? o.buyer_payment)}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap', color: '#ef4444' }}>
                  {fmtMoney(o.all_services_fee)}
                  {forecast && FORECAST_BADGE}
                </td>
                <SupplierPriceCell order={o} storeId={storeId} onUpdated={onOrderUpdated} />
                <td style={{
                  padding: '7px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600,
                  color: profit == null ? '#9ca3af' : profit >= 0 ? '#16a34a' : '#ef4444',
                }}>
                  {fmtMoney(profit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- editable supplier price cell ----------

function SupplierPriceCell({ order, storeId, onUpdated }: { order: Order; storeId: number; onUpdated: (id: number, price: number | null, isManual: boolean) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(order.supplier_price != null ? String(order.supplier_price) : '');
  const [saving, setSaving] = React.useState(false);

  const needsInput = !order.supplier_price_is_manual;

  async function save() {
    setSaving(true);
    const parsed = value.trim() === '' ? null : parseFloat(value.replace(',', '.'));
    try {
      await updateOrderSupplierPrice(storeId, order.id, parsed);
      onUpdated(order.id, parsed, true);
      setEditing(false);
    } catch (_) { /* ignore */ }
    setSaving(false);
  }

  if (editing) {
    return (
      <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', textAlign: 'right', background: '#fef9c3' }}>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          style={{ width: 80, padding: '2px 4px', border: '1px solid #2563eb', borderRadius: 4, fontSize: 12, textAlign: 'right' }}
        />
        <button onClick={save} disabled={saving} style={{ marginLeft: 4, padding: '2px 6px', fontSize: 11, borderRadius: 4, border: 'none', background: '#16a34a', color: 'white', cursor: 'pointer' }}>✓</button>
        <button onClick={() => setEditing(false)} style={{ marginLeft: 2, padding: '2px 6px', fontSize: 11, borderRadius: 4, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer' }}>✕</button>
      </td>
    );
  }

  return (
    <td
      style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: 12, textAlign: 'right', cursor: 'pointer',
        background: needsInput ? '#fef9c3' : undefined,
        color: needsInput ? '#92400e' : '#6b7280',
      }}
      title={needsInput ? 'Введите фактическую цену закупа' : 'Нажмите для редактирования'}
      onClick={() => setEditing(true)}
    >
      {order.supplier_price != null
        ? <>{order.supplier_price.toLocaleString('ru-RU')} ₽{needsInput && <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.7 }}>✎</span>}</>
        : <span style={{ color: '#d97706', fontWeight: 500 }}>+ ввести</span>
      }
    </td>
  );
}

// ---------- detailed orders table ----------

function DetailedOrdersTable({ orders, storeId, onOrderUpdated }: TableProps & { storeId: number; onOrderUpdated: (id: number, price: number | null, isManual: boolean) => void }) {
  if (!orders.length) return <div style={{ color: '#6b7280', padding: 16 }}>Нет заказов за выбранный период</div>;

  const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', color: '#374151', fontSize: 12 };
  const td: React.CSSProperties = { padding: '6px 10px', whiteSpace: 'nowrap', fontSize: 12 };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
            {['Дата', 'Заказ', 'Товар', 'Вид', 'Выручка', 'Субсидия ЯМ', 'Комиссия', 'Налог', 'Закупка ✎', 'Прибыль', 'Маржа %'].map(h => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map(o => {
            const revenue = o.revenue ?? o.buyer_payment;
            const profit = o.profit;
            const forecast = isForecast(o);
            const needsSupplier = !o.supplier_price_is_manual;
            return (
              <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6', background: needsSupplier ? '#fffbeb' : undefined }}>
                <td style={{ ...td, color: '#6b7280' }}>
                  {o.order_date ? o.order_date.split('-').reverse().join('.') : '—'}
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{o.order_id}</td>
                <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={o.offer_name ?? ''}>
                  {o.offer_name || '—'}
                </td>
                <td style={td}>
                  <span style={{
                    display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500,
                    background: kindColor(o.order_kind) + '22', color: kindColor(o.order_kind),
                  }}>
                    {kindLabel(o.order_kind)}
                  </span>
                </td>
                <td style={tdR}>{fmtMoney(revenue)}</td>
                <td style={{ ...tdR, color: o.promo_discount ? '#16a34a' : '#9ca3af' }}>{o.promo_discount ? `+${fmtMoney(o.promo_discount)}` : '—'}</td>
                <td style={{ ...tdR, color: '#ef4444' }} title={
                  o.fee_details && o.fee_details.filter(d => d.type !== 'TAX' && d.type !== 'SUBSIDY').length > 0
                    ? o.fee_details.filter(d => d.type !== 'TAX' && d.type !== 'SUBSIDY').map(d => `${d.label}: ${fmtMoney(d.amount)}`).join('\n')
                    : undefined
                }>
                  {fmtMoney(
                    !o.is_forecast && o.fees_total != null
                      ? Math.round((o.fees_total - (o.tax_amount ?? 0)) * 100) / 100
                      : o.commission_amount
                  )}
                  {forecast && FORECAST_BADGE}
                </td>
                <td style={{ ...tdR, color: '#6b7280' }}>{fmtMoney(o.tax_amount)}</td>
                <SupplierPriceCell order={o} storeId={storeId} onUpdated={onOrderUpdated} />
                <td style={{ ...tdR, fontWeight: 600, color: profit == null ? '#9ca3af' : profit >= 0 ? '#16a34a' : '#ef4444' }}>
                  {fmtMoney(profit)}
                </td>
                <td style={{ ...tdR, color: o.margin_pct == null ? '#9ca3af' : o.margin_pct >= 0 ? '#16a34a' : '#ef4444' }}>
                  {o.margin_pct != null ? `${o.margin_pct}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- page ----------

const STORE_NAME: Record<string, string> = { '1': 'ЯМ16', '2': 'ЯМ21', yam16: 'ЯМ16', yam21: 'ЯМ21' };

export default function SalesPage() {
  const { storeId } = useParams<{ storeId: string }>();
  const numericId = storeId === 'yam16' ? 1 : storeId === 'yam21' ? 2 : Number(storeId);

  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(today());
  const [summary, setSummary] = useState<OrdersSummary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [detailedView, setDetailedView] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [receivables, setReceivables] = useState<Receivables | null>(null);
  const [receivablesLoading, setReceivablesLoading] = useState(false);
  const [receivablesError, setReceivablesError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchOrdersSummary(numericId, dateFrom, dateTo),
      fetchOrders(numericId, { date_from: dateFrom, date_to: dateTo, limit: 1000 }),
    ])
      .then(([s, o]) => {
        setSummary(s);
        setOrders(o);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  function loadReceivables() {
    setReceivablesLoading(true);
    setReceivablesError(null);
    fetchReceivables(numericId)
      .then(r => setReceivables(r))
      .catch(e => setReceivablesError(e.message))
      .finally(() => setReceivablesLoading(false));
  }

  useEffect(() => { load(); }, [numericId, dateFrom, dateTo]);
  useEffect(() => { loadReceivables(); }, [numericId]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await syncOrders(numericId, dateFrom, dateTo);
      setSyncMsg(`Синхронизация завершена: добавлено ${res.added} строк`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  const storeName = STORE_NAME[storeId ?? ''] ?? storeId;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Продажи — {storeName}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#6b7280' }}>
            С&nbsp;
            <input
              type="date" value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
          </label>
          <label style={{ fontSize: 13, color: '#6b7280' }}>
            По&nbsp;
            <input
              type="date" value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
          </label>
          <button
            className="button"
            onClick={handleSync}
            disabled={syncing}
            style={{ whiteSpace: 'nowrap' }}
          >
            {syncing ? 'Загрузка из ЯМ...' : 'Синхронизировать из ЯМ'}
          </button>
        </div>
      </div>

      {syncMsg && <div style={{ background: '#d1fae5', color: '#065f46', padding: '10px 16px', borderRadius: 8, marginBottom: 16 }}>{syncMsg}</div>}
      {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 16px', borderRadius: 8, marginBottom: 16 }}>{error}</div>}

      {loading && <div style={{ color: '#6b7280', marginBottom: 16 }}>Загрузка...</div>}

      {summary && <SummaryCards summary={summary} />}

      {summary && summary.daily.length > 0 && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>Динамика по дням</div>
          <SalesChart data={summary.daily} />
        </div>
      )}

      {summary && summary.matched_orders < summary.total_orders && (
        <div style={{
          background: '#fef3c7', color: '#92400e', padding: '10px 16px',
          borderRadius: 8, marginBottom: 16, fontSize: 13,
        }}>
          Закупочная стоимость найдена только для {summary.matched_orders} из {summary.total_orders} заказов.
          Сопоставьте товары в разделе «Сопоставление» для полного расчёта прибыли.
        </div>
      )}

      <ReceivablesBlock
        data={receivables ?? { total: 0, adjusted: 0, nonpickup_pct: 0, return_pct: 0 }}
        loading={receivablesLoading}
        error={receivablesError}
      />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Заказы ({orders.length})</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['Сводная', 'Подробная'] as const).map(label => (
              <button
                key={label}
                onClick={() => setDetailedView(label === 'Подробная')}
                style={{
                  padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db', cursor: 'pointer',
                  fontSize: 12, fontWeight: 500,
                  background: (label === 'Подробная') === detailedView ? '#111827' : '#fff',
                  color: (label === 'Подробная') === detailedView ? '#fff' : '#374151',
                }}
              >{label}</button>
            ))}
          </div>
        </div>
        {detailedView
          ? <DetailedOrdersTable
              orders={orders}
              storeId={numericId}
              onOrderUpdated={(id, price, isManual) => setOrders(prev => prev.map(o => o.id === id ? { ...o, supplier_price: price, supplier_price_is_manual: isManual } : o))}
            />
          : <OrdersTable
              orders={orders}
              storeId={numericId}
              onOrderUpdated={(id, price, isManual) => setOrders(prev => prev.map(o => o.id === id ? { ...o, supplier_price: price, supplier_price_is_manual: isManual } : o))}
            />
        }
      </div>
    </div>
  );
}
