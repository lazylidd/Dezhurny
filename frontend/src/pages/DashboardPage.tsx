import { useEffect, useState } from 'react';
import LoadingCats from '../components/ui/LoadingCats';
import { Link } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { fetchDashboard, type DashboardData, type ChartPoint } from '../api/dashboard';
import { fetchReceivables } from '../api/orders';
import { fetchPromoSyncStats } from '../api/prices';
import type { Receivables } from '../types/order';

const STORE_SLUG: Record<number, string> = { 1: 'yam16', 2: 'yam21' };

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtRub(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function filterChart(chart: ChartPoint[], days: number | null, from?: string, to?: string): ChartPoint[] {
  if (!chart.length) return chart;
  if (from || to) {
    return chart.filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
  }
  if (days == null) return chart;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return chart.filter((p) => p.date >= cutoff.toISOString().slice(0, 10));
}

function formatChartDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
}

function KpiCard({ label, value, sub }: KpiCardProps) {
  return (
    <div className="card">
      <div className="card__label">{label}</div>
      <div className="card__value" style={{ color: '#1f2937', fontSize: '24px' }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>{sub}</div>}
    </div>
  );
}

const CHART_TOOLTIP_STYLE = {
  background: '#1f2937',
  border: 'none',
  borderRadius: '8px',
  color: 'white',
  fontSize: '13px',
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={CHART_TOOLTIP_STYLE}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #374151', fontWeight: 600 }}>{label}</div>
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {payload.map((p: any) => (
          <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
            <span style={{ color: p.color }}>{p.name}</span>
            <span>{fmtRub(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function today() { return new Date().toISOString().slice(0, 10); }
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [receivables, setReceivables] = useState<Record<number, Receivables>>({});
  const [loading, setLoading] = useState(true);
  const [periodFrom, setPeriodFrom] = useState(firstOfMonth());
  const [periodTo, setPeriodTo] = useState(today());
  const [chartDays, setChartDays] = useState<number | null>(30);
  const [chartFrom, setChartFrom] = useState('');
  const [chartTo, setChartTo] = useState('');
  const [promoStats, setPromoStats] = useState<{ in_promo: number; in_promo_with_stock: number } | null>(null);

  function loadDashboard() {
    setLoading(true);
    fetchDashboard(periodFrom, periodTo)
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadDashboard();
    fetchPromoSyncStats().then(setPromoStats).catch(() => {});
  }, [periodFrom, periodTo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!data) return;
    data.stores.forEach((s) => {
      fetchReceivables(s.id)
        .then((r) => setReceivables((prev) => ({ ...prev, [s.id]: r })))
        .catch(() => {});
    });
  }, [data]);

  if (loading) return <LoadingCats />;
  if (!data) return <p style={{ padding: '32px', color: '#b91c1c' }}>Ошибка загрузки данных</p>;

  const { combined, stores, chart } = data;

  const totalReceivables = Object.values(receivables).reduce((s, r) => s + r.total, 0);
  const totalEnabled = stores.reduce((s, st) => s + st.enabled_products, 0);

  const customMode = !!(chartFrom || chartTo);
  const chartData = filterChart(chart, customMode ? null : chartDays, chartFrom || undefined, chartTo || undefined).map((p) => ({
    ...p,
    date: formatChartDate(p.date),
    revenue: Math.round(p.revenue),
    profit: Math.round(p.profit),
    fees: Math.round(p.fees),
  }));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Главная</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            С&nbsp;<input type="date" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
          </label>
          <label style={{ fontSize: 13, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            По&nbsp;<input type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
          </label>
          <button onClick={loadDashboard} disabled={loading}
            style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: 13 }}>
            {loading ? '...' : 'Обновить'}
          </button>
        </div>
      </div>

      {/* KPI — строка 1: финансовые результаты */}
      <div className="card-grid">
        <KpiCard
          label="Выручка"
          value={fmtRub(combined.revenue)}
          sub={`${fmt(combined.orders)} заказов`}
        />
        <KpiCard
          label="Прибыль"
          value={fmtRub(combined.profit)}
          sub={combined.profit != null && combined.revenue > 0
            ? `${((combined.profit / combined.revenue) * 100).toFixed(1)}% от выручки`
            : undefined}
        />
        <KpiCard
          label="ROI"
          value={combined.roi != null ? `${(combined.roi * 100).toFixed(1)}%` : '—'}
          sub="прибыль / закуп"
        />
        <KpiCard
          label="Комиссии маркета"
          value={fmtRub(combined.fees - combined.tax_sum)}
          sub={`${combined.fees_actual_pct != null
            ? `${(combined.fees_actual_pct * 100).toFixed(1)}% от завершённых · `
            : ''}налог (УСН): ${fmtRub(combined.tax_sum)}`}
        />
      </div>

      {/* KPI — строка 2: деньги в пути + ассортимент + оборот + качество */}
      <div className="card-grid">
        <KpiCard
          label="Дебиторка ЯМ"
          value={Object.keys(receivables).length > 0 ? fmtRub(totalReceivables) : 'загрузка...'}
          sub="ждем на счета от МП"
        />
        <KpiCard
          label="Товары в продаже"
          value={fmt(totalEnabled)}
          sub={promoStats
            ? `${fmt(promoStats.in_promo_with_stock)} в акциях · обновлены остатки и нет ошибок`
            : 'обновлены остатки и нет ошибок'}
        />
        <KpiCard
          label="Оборот"
          value={combined.avg_turnover != null ? `${combined.avg_turnover} дн.` : '—'}
          sub="среднее время отгрузка → выплата"
        />
        <div className="card">
          <div className="card__label">Невыкупы / Возвраты</div>
          <div style={{ display: 'flex', gap: '16px', marginTop: '4px' }}>
            <div>
              <div className="card__value" style={{ fontSize: '22px', color: '#1f2937' }}>
                {fmtPct(combined.nonpickup_pct)}
              </div>
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>невыкупы · {fmt(combined.nonpickup_count)} шт</div>
            </div>
            <div style={{ width: '1px', background: '#e5e7eb', alignSelf: 'stretch' }} />
            <div>
              <div className="card__value" style={{ fontSize: '22px', color: '#1f2937' }}>
                {fmtPct(combined.return_pct)}
              </div>
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>возвраты · {fmt(combined.return_count)} шт</div>
            </div>
          </div>
        </div>
      </div>

      {/* График */}
      <div className="section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <h2 style={{ margin: 0 }}>Динамика продаж (все магазины)</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => { setChartDays(d); setChartFrom(''); setChartTo(''); }}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: '1px solid #e5e7eb',
                  background: !customMode && chartDays === d ? '#2563eb' : 'white',
                  color: !customMode && chartDays === d ? 'white' : '#374151',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                {d} дн.
              </button>
            ))}
            <div style={{ width: '1px', height: '20px', background: '#e5e7eb' }} />
            <input
              type="date"
              value={chartFrom}
              onChange={(e) => { setChartFrom(e.target.value); setChartDays(null); }}
              style={{ padding: '5px 8px', border: `1px solid ${customMode ? '#2563eb' : '#e5e7eb'}`, borderRadius: '6px', fontSize: '13px', color: '#374151' }}
            />
            <span style={{ fontSize: '13px', color: '#6b7280' }}>—</span>
            <input
              type="date"
              value={chartTo}
              onChange={(e) => { setChartTo(e.target.value); setChartDays(null); }}
              style={{ padding: '5px 8px', border: `1px solid ${customMode ? '#2563eb' : '#e5e7eb'}`, borderRadius: '6px', fontSize: '13px', color: '#374151' }}
            />
            {customMode && (
              <button
                onClick={() => { setChartFrom(''); setChartTo(''); setChartDays(30); }}
                style={{ padding: '5px 10px', borderRadius: '6px', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '12px', color: '#6b7280' }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="card" style={{ padding: '24px 16px 16px' }}>
          {chartData.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#6b7280', padding: '40px' }}>Нет данных за выбранный период</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#16a34a" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => v >= 1000 ? `${Math.round(v / 1000)}к` : v}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '13px', paddingTop: '8px' }}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  name="Выручка"
                  stroke="#2563eb"
                  strokeWidth={2}
                  fill="url(#colorRevenue)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="profit"
                  name="Прибыль"
                  stroke="#16a34a"
                  strokeWidth={2}
                  fill="url(#colorProfit)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="fees"
                  name="Комиссии"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  fill="none"
                  dot={false}
                  activeDot={{ r: 4 }}
                  strokeDasharray="4 4"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Карточки магазинов */}
      <div className="section">
        <h2>Магазины</h2>
        <div className="store-grid">
          {stores.map((store) => {
            const slug = STORE_SLUG[store.id] ?? String(store.id);
            const rec = receivables[store.id];
            const np_pct = store.nonpickup_count > 0
              ? store.nonpickup_count / (store.orders + store.nonpickup_count)
              : null;
            return (
              <Link key={store.id} to={`/store/${slug}/analytics`} style={{ textDecoration: 'none' }}>
                <div className="card" style={{ cursor: 'pointer', transition: 'box-shadow 0.15s' }}
                  onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)')}
                  onMouseLeave={(e) => (e.currentTarget.style.boxShadow = '')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ margin: 0, fontSize: '18px' }}>{store.name}</h3>
                    <span style={{ fontSize: '12px', color: '#6b7280', background: '#f3f4f6', padding: '2px 8px', borderRadius: '999px' }}>
                      Яндекс Маркет
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>Выручка (месяц)</div>
                      <div style={{ fontSize: '15px', fontWeight: 700 }}>{fmtRub(store.revenue)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>Прибыль (месяц)</div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: store.profit != null ? (store.profit >= 0 ? '#166534' : '#b91c1c') : '#6b7280' }}>
                        {fmtRub(store.profit)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>Заказов (месяц)</div>
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>{fmt(store.orders)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>% невыкупов</div>
                      <div style={{ fontSize: '15px', fontWeight: 600, color: np_pct != null ? (np_pct > 0.15 ? '#b91c1c' : '#1f2937') : '#6b7280' }}>
                        {fmtPct(np_pct)}
                      </div>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: '10px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>
                      В наличии: <b style={{ color: '#1f2937' }}>{store.enabled_products}</b>
                    </span>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>
                      Обнулено: <b style={{ color: '#1f2937' }}>{store.zeroed_products}</b>
                    </span>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>
                      Обновлено сегодня: <b style={{ color: '#2563eb' }}>{store.updated_today}</b>
                    </span>
                    {rec && (
                      <span style={{ fontSize: '12px', color: '#6b7280' }}>
                        Дебиторка: <b style={{ color: '#1d4ed8' }}>{fmtRub(rec.total)}</b>
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
