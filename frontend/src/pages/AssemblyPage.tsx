import { useEffect, useState, useRef } from 'react';
import LoadingCats from '../components/ui/LoadingCats';
import {
  fetchAssembly,
  fetchAssemblyShipments,
  shipmentListUrl,
  actUrl,
  markOrdersReady,
  downloadAllDocuments,
  downloadAllLabels,
  fetchDownload,
  type AssemblyStore,
  type AssemblyItem,
  type FeeDetail,
  type Shipment,
  type StoreDocRequest,
  type CampaignLabelsRequest,
} from '../api/assembly';
import { apiFetch } from '../api/client';

// ─── форматирование ────────────────────────────────────────────────────────────

function fmtRub(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₽';
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return (v * 100).toFixed(1) + '%';
}

function profitColor(v: number | null): string {
  if (v == null) return '#6b7280';
  return v >= 0 ? '#16a34a' : '#dc2626';
}

// ─── кнопка скачивания с loading state ────────────────────────────────────────

function DownloadBtn({
  label, loadingLabel = 'Загрузка...', onFetch, style,
}: {
  label: string;
  loadingLabel?: string;
  onFetch: () => Promise<{ blob: Blob; filename: string }>;
  style?: React.CSSProperties;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setErr(null);
    try {
      const { blob, filename } = await onFetch();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
      <button onClick={handleClick} disabled={loading} style={{ ...style, opacity: loading ? 0.7 : 1, cursor: loading ? 'wait' : 'pointer' }}>
        {loading ? loadingLabel : label}
      </button>
      {err && <span style={{ fontSize: '11px', color: '#dc2626', maxWidth: '200px' }}>{err}</span>}
    </span>
  );
}

// ─── детализация сборов (разворачиваемая строка) ──────────────────────────────

const TARIFF_LABELS: Record<string, string> = {
  FEE: 'Комиссия ЯМ',
  FIXED: 'Доставка/фикс.',
  DELIVERY_TO_CUSTOMER: 'Доставка до покупателя',
  MIDDLE_MILE: 'Магистраль',
  PAYMENT_TRANSFER: 'Перевод платежа',
  AGENCY_COMMISSION: 'Агентская комиссия',
  FF: 'Фулфилмент',
  STORAGE: 'Хранение',
  TAX: 'Налог (УСН)',
  SUBSIDY: 'Субсидия ЯМ',
};

function FeesRow({ details, source, fees, totalBuyer, colSpan }: { details: FeeDetail[]; source: string; fees: number; totalBuyer: number; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '0 0 8px 32px', background: '#f9fafb' }}>
        <div style={{ padding: '8px 12px', background: '#f1f5f9', borderRadius: '6px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px' }}>
            {details.map((d, i) => (
              <span key={i} style={{ fontSize: '12px', color: '#374151', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <span style={{ color: d.type === 'TAX' ? '#7c3aed' : d.type === 'SUBSIDY' ? '#16a34a' : '#6b7280', fontWeight: 500 }}>
                  {TARIFF_LABELS[d.type] ?? d.type}
                </span>
                <span>
                  <strong>{d.amount.toLocaleString('ru-RU')} ₽</strong>
                  <span style={{ color: '#9ca3af', marginLeft: '4px' }}>({d.pct.toFixed(1)}%)</span>
                </span>
              </span>
            ))}
          </div>
          {totalBuyer > 0 && (
            <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #e2e8f0', fontSize: '12px', color: '#374151', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ color: '#6b7280' }}>Итого издержек:</span>
              <strong>{fees.toLocaleString('ru-RU')} ₽</strong>
              <span style={{ color: '#9ca3af' }}>({((fees / totalBuyer) * 100).toFixed(1)}% от цены)</span>
              {source === 'commission' && <span style={{ color: '#f59e0b' }}>⚠ ставка из БД — запустите пересчёт</span>}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── статус заказа ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  PROCESSING: 'Сборка',
  READY_TO_SHIP: 'Готов к отгрузке',
  DELIVERY: 'В доставке',
  PICKUP: 'В доставке',
};

const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  PROCESSING:    { bg: '#fef3c7', color: '#92400e' },
  READY_TO_SHIP: { bg: '#dcfce7', color: '#166534' },
  DELIVERY:      { bg: '#dbeafe', color: '#1e40af' },
  PICKUP:        { bg: '#dbeafe', color: '#1e40af' },
};

// ─── блок одного магазина ─────────────────────────────────────────────────────

function StoreAssemblyBlock({ store, onRefresh }: { store: AssemblyStore; onRefresh: () => void }) {
  const [readyLoading, setReadyLoading] = useState(false);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [readyCampaigns, setReadyCampaigns] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const orders = store.orders;

  function loadShipments() {
    fetchAssemblyShipments(store.store_id).then(setShipments).catch(() => setShipments([]));
  }

  useEffect(() => { loadShipments(); }, [store.store_id]);

  function toggleFees(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // Группируем по order_id + campaign_id
  const grouped = new Map<string, { campaign_id: number; status: string; items: AssemblyItem[] }>();
  for (const item of orders) {
    const key = `${item.campaign_id}:${item.order_id}`;
    if (!grouped.has(key)) {
      grouped.set(key, { campaign_id: item.campaign_id, status: item.status, items: [] });
    }
    grouped.get(key)!.items.push(item);
  }

  // Итоги магазина
  const totalProfit = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const totalRevenue = orders.reduce((s, o) => s + o.total_buyer, 0);
  const ros = totalRevenue > 0 ? totalProfit / totalRevenue : null;
  const totalSupplier = orders.reduce((s, o) => s + (o.total_supplier ?? 0), 0);
  const roi = totalSupplier > 0 ? totalProfit / totalSupplier : null;

  // Уникальные order_ids по campaign + признак "все готовы"
  const bycamp = new Map<number, string[]>();
  const campAllReady = new Map<number, boolean>(); // все заказы кампании READY_TO_SHIP
  for (const item of orders) {
    if (!bycamp.has(item.campaign_id)) {
      bycamp.set(item.campaign_id, []);
      campAllReady.set(item.campaign_id, true);
    }
    if (!bycamp.get(item.campaign_id)!.includes(item.order_id)) {
      bycamp.get(item.campaign_id)!.push(item.order_id);
    }
    if (item.status !== 'READY_TO_SHIP' && item.status !== 'DELIVERY' && item.status !== 'PICKUP') {
      campAllReady.set(item.campaign_id, false);
    }
  }

  async function handleMarkReady(campaignId: number, ids: string[]) {
    setReadyLoading(true);
    setReadyError(null);
    try {
      const res = await markOrdersReady(store.store_id, campaignId, ids);
      const fail = res.results.filter(r => !r.ok);
      if (fail.length === 0) {
        setReadyCampaigns(prev => new Set(prev).add(campaignId));
        loadShipments();
        onRefresh(); // обновляем статусы из API
      } else {
        setReadyError(`Ошибок: ${fail.length} — ${fail[0]?.error ?? ''}`);
      }
    } catch (e: unknown) {
      setReadyError('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReadyLoading(false);
    }
  }

  if (grouped.size === 0) return null;

  return (
    <div className="card" style={{ marginBottom: '16px' }}>
      {/* Заголовок */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ fontWeight: 700, fontSize: '16px' }}>{store.store_name}</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', color: '#374151' }}>
            <b>{grouped.size}</b> заказов · выручка <b>{fmtRub(totalRevenue)}</b> · прибыль <b style={{ color: profitColor(totalProfit) }}>{fmtRub(totalProfit)}</b> · ROI <b>{fmtPct(roi)}</b> · ROS <b>{fmtPct(ros)}</b>
          </span>
          {/* Ярлыки — один файл на весь магазин */}
          {(() => {
            const allCamps: CampaignLabelsRequest[] = Array.from(bycamp.entries())
              .filter(([, ids]) => ids.length > 0)
              .map(([cid, ids]) => ({ campaign_id: cid, order_ids: ids }));
            if (allCamps.length === 0) return null;
            return (
              <DownloadBtn
                label={`Ярлыки ${store.store_name}`}
                loadingLabel="Загрузка ярлыков..."
                onFetch={() => downloadAllLabels(store.store_id, allCamps)}
                style={{ padding: '5px 11px', fontSize: '12px', background: '#374151', color: 'white', borderRadius: '6px', border: 'none', fontWeight: 500 }}
              />
            );
          })()}
          {/* Per-campaign: собрать / лист сборки */}
          {store.campaign_ids.map((cid) => {
            const ids = bycamp.get(cid) || [];
            if (ids.length === 0) return null;
            const isReady = readyCampaigns.has(cid) || campAllReady.get(cid) === true;
            const campaignShipments = (shipments || []).filter(s => s.campaign_id === cid);
            return (
              <span key={cid} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                {isReady ? (
                  <DownloadBtn
                    label={`Лист сборки ${store.store_name}`}
                    loadingLabel="Генерация листа сборки..."
                    onFetch={() => fetchDownload(shipmentListUrl(store.store_id, cid, ids, campaignShipments[0]?.id))}
                    style={{ padding: '5px 11px', fontSize: '12px', background: 'white', color: '#374151', border: '1px solid #e5e7eb', borderRadius: '6px', fontWeight: 500 }}
                  />
                ) : (
                  <button
                    onClick={() => handleMarkReady(cid, ids)}
                    disabled={readyLoading}
                    style={{ padding: '5px 11px', fontSize: '12px', background: '#16a34a', color: 'white', borderRadius: '6px', border: 'none', cursor: readyLoading ? 'wait' : 'pointer', fontWeight: 500 }}
                  >
                    {readyLoading ? '...' : 'Собрать заказ'}
                  </button>
                )}
              </span>
            );
          })}
          {readyError && <span style={{ fontSize: '12px', color: '#dc2626' }}>{readyError}</span>}
        </div>
      </div>

      {/* Таблица заказов */}
      <div className="table-wrapper" style={{ marginBottom: '16px' }}>
        <table className="table">
          <thead>
            <tr>
              <th className="th" style={{ width: 110 }}>Заказ</th>
              <th className="th" style={{ width: 90 }}>Статус</th>
              <th className="th">Товар</th>
              <th className="th" style={{ width: 60 }}>Кол-во</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Цена продажи</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Закупка</th>
              <th className="th" style={{ width: 90, textAlign: 'right' }}>Прибыль</th>
              <th className="th" style={{ width: 70, textAlign: 'right' }}>ROI</th>
              <th className="th" style={{ width: 70, textAlign: 'right' }}>ROS</th>
              <th className="th" style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {Array.from(grouped.entries()).map(([key, group]) => (
              group.items.flatMap((item, idx) => {
                const sc = STATUS_COLOR[item.status] ?? { bg: '#f3f4f6', color: '#374151' };
                const feeKey = `${key}-${idx}`;
                const isExpanded = expanded.has(feeKey);
                const hasFees = item.fee_details && item.fee_details.length > 0;
                return [
                  <tr key={feeKey} className="tr">
                    {idx === 0 && (
                      <td className="td" rowSpan={group.items.length} style={{ fontFamily: 'monospace', fontSize: '11px', verticalAlign: 'top', paddingTop: '10px' }}>
                        {item.order_id}
                      </td>
                    )}
                    {idx === 0 && (
                      <td className="td" rowSpan={group.items.length} style={{ verticalAlign: 'top', paddingTop: '10px' }}>
                        <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: '10px', fontSize: '11px', fontWeight: 500, background: sc.bg, color: sc.color }}>
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </td>
                    )}
                    <td className="td" style={{ fontSize: '12px' }}>{item.offer_name || item.sku}</td>
                    <td className="td" style={{ textAlign: 'center', fontSize: '13px' }}>{item.count}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: '13px' }}>{fmtRub(item.total_buyer)}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: '13px', color: '#6b7280' }}>{fmtRub(item.total_supplier)}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: '13px', fontWeight: 600, color: profitColor(item.profit) }}>{fmtRub(item.profit)}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: '12px' }}>{fmtPct(item.roi)}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: '12px' }}>{fmtPct(item.ros)}</td>
                    <td className="td">
                      {hasFees && (
                        <button
                          onClick={() => toggleFees(feeKey)}
                          style={{ padding: '3px 8px', fontSize: '11px', background: 'none', border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer', color: '#6b7280', whiteSpace: 'nowrap' }}
                        >
                          {isExpanded ? '▲ скрыть' : '▼ тарифы'}
                        </button>
                      )}
                    </td>
                  </tr>,
                  isExpanded && hasFees
                    ? <FeesRow key={`${feeKey}-fees`} details={item.fee_details} source={item.fee_source} fees={item.fees} totalBuyer={item.total_buyer} colSpan={10} />
                    : null,
                ];
              })
            ))}
          </tbody>
        </table>
      </div>

      {/* Акты отгрузок — без заголовка */}
      {shipments && shipments.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
          {shipments.map((s) => {
            const from = s.planIntervalFrom ? new Date(s.planIntervalFrom).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
            const to = s.planIntervalTo ? new Date(s.planIntervalTo).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }) : '';
            const cid = store.campaign_ids.find(c => c === s.campaign_id) ?? store.campaign_ids[0];
            return (
              <div key={`${s.id}-${s.campaign_id}`} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '6px 10px', fontSize: '12px', background: '#f9fafb', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#6b7280' }}>{from}{to ? ` — ${to}` : ''} МСК</span>
                <DownloadBtn
                  label="↓ Акт"
                  loadingLabel="Загрузка..."
                  onFetch={() => fetchDownload(actUrl(store.store_id, cid, s.id))}
                  style={{ padding: '2px 8px', fontSize: '11px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: '5px', fontWeight: 500 }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── страница ─────────────────────────────────────────────────────────────────

export default function AssemblyPage() {
  const [stores, setStores] = useState<AssemblyStore[] | null>(null);
  const [beforeCutoff, setBeforeCutoff] = useState<boolean | null>(null);
  const [cutoffTime, setCutoffTime] = useState<string>('10:00');
  const [cutoffInput, setCutoffInput] = useState<string>('10:00');
  const [savingCutoff, setSavingCutoff] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cutoffInitialized = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allReadyLoading, setAllReadyLoading] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const cutoffSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchAssembly()
      .then((resp) => {
        // fallback: старый бэкенд мог вернуть массив напрямую
        if (Array.isArray(resp)) {
          setStores(resp as unknown as AssemblyStore[]);
          setBeforeCutoff(false);
          return;
        }
        setBeforeCutoff(resp.before_cutoff ?? false);
        setCutoffTime(resp.cutoff_time ?? '10:00');
        if (!cutoffInitialized.current) {
          setCutoffInput(resp.cutoff_time ?? '10:00');
          cutoffInitialized.current = true;
        }
        setStores(resp.stores ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function saveCutoffTime(val: string) {
    setSavingCutoff(true);
    setSaveError(null);
    try {
      await apiFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_cutoff_time: val }),
      });
      setCutoffTime(val);
    } catch (e) {
      setSaveError('Не сохранилось: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingCutoff(false);
    }
  }

  function handleCutoffChange(val: string) {
    setCutoffInput(val);
    if (cutoffSaveTimer.current) clearTimeout(cutoffSaveTimer.current);
    cutoffSaveTimer.current = setTimeout(() => saveCutoffTime(val), 800);
  }

  const data = stores;
  const activeStores = stores?.filter(st => st.orders.length > 0) ?? [];

  const totalOrders = activeStores.reduce((s, st) => {
    const uniq = new Set(st.orders.map(o => o.order_id));
    return s + uniq.size;
  }, 0);

  const allOrders = activeStores.flatMap(st => st.orders);
  const totalRevenue = allOrders.reduce((s, o) => s + o.total_buyer, 0);
  const totalProfit = allOrders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const totalSupplier = allOrders.reduce((s, o) => s + (o.total_supplier ?? 0), 0);
  const avgRoi = totalSupplier > 0 ? totalProfit / totalSupplier : null;
  const avgRos = totalRevenue > 0 ? totalProfit / totalRevenue : null;
  const totalPositions = allOrders.reduce((s, o) => s + o.count, 0);

  // Собрать все заказы
  async function handleMarkAllReady() {
    if (!stores) return;
    setAllReadyLoading(true);
    for (const store of activeStores) {
      const bycamp = new Map<number, string[]>();
      for (const item of store.orders) {
        if (item.status !== 'PROCESSING') continue; // только несданные (не READY, не DELIVERY)
        if (!bycamp.has(item.campaign_id)) bycamp.set(item.campaign_id, []);
        if (!bycamp.get(item.campaign_id)!.includes(item.order_id)) {
          bycamp.get(item.campaign_id)!.push(item.order_id);
        }
      }
      for (const [campaignId, ids] of bycamp.entries()) {
        try {
          await markOrdersReady(store.store_id, campaignId, ids);
        } catch (_) {/* continue */}
      }
    }
    setAllReadyLoading(false);
    load();
  }

  // Скачать все документы (ZIP)
  async function handleDownloadAll() {
    if (!stores) return;
    setZipLoading(true);
    setZipError(null);
    try {
      const stores: StoreDocRequest[] = activeStores.map(store => {
        const bycampMap = new Map<number, string[]>();
        for (const item of store.orders) {
          if (!bycampMap.has(item.campaign_id)) bycampMap.set(item.campaign_id, []);
          if (!bycampMap.get(item.campaign_id)!.includes(item.order_id)) {
            bycampMap.get(item.campaign_id)!.push(item.order_id);
          }
        }
        return {
          store_id: store.store_id,
          store_name: store.store_name,
          campaigns: Array.from(bycampMap.entries()).map(([cid, ids]) => ({
            campaign_id: cid,
            order_ids: ids,
          })),
        };
      });
      const blob = await downloadAllDocuments(stores);
      const today = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `сборка_${today}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setZipError('Ошибка: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setZipLoading(false);
    }
  }

  const hasProcessing = activeStores.some(st => st.orders.some(o => o.status === 'PROCESSING'));

  async function exportPurchaseList() {
    const res = await fetch('/api/assembly/purchase-list.pdf', { credentials: 'include' });
    if (!res.ok) { alert('Ошибка генерации PDF'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toLocaleDateString('ru-RU').replace(/\./g, '-');
    a.href = url;
    a.download = `закупочный_лист_${dateStr}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0 }}>Сборка заказов</h1>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#6b7280' }}>
            Приём заказов до:
            <input
              type="time"
              value={cutoffInput}
              onChange={(e) => handleCutoffChange(e.target.value)}
              style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: '5px', fontSize: '13px', color: '#111827', cursor: 'pointer' }}
            />
            {savingCutoff && <span style={{ fontSize: '11px', color: '#9ca3af' }}>сохранение...</span>}
            {!savingCutoff && saveError && <span style={{ fontSize: '11px', color: '#dc2626' }}>{saveError}</span>}
          </label>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {data && hasProcessing && (
            <button
              className="button"
              onClick={handleMarkAllReady}
              disabled={allReadyLoading}
              style={{ background: '#16a34a', cursor: allReadyLoading ? 'wait' : 'pointer', fontWeight: 600 }}
            >
              {allReadyLoading ? 'Собираем...' : 'Собрать все'}
            </button>
          )}
          {data && activeStores.length > 0 && (
            <>
              <button
                className="button"
                onClick={exportPurchaseList}
                style={{ fontWeight: 600, background: 'white', color: '#374151', border: '1px solid #d1d5db' }}
              >
                Закупочный лист
              </button>
              <button
                className="button"
                onClick={handleDownloadAll}
                disabled={zipLoading}
                style={{ cursor: zipLoading ? 'wait' : 'pointer', fontWeight: 600 }}
              >
                {zipLoading ? 'Генерация...' : 'Скачать все документы'}
              </button>
            </>
          )}
          <button className="button" onClick={load} disabled={loading}>
            {loading ? 'Загрузка...' : 'Обновить'}
          </button>
        </div>
      </div>
      {zipError && <div style={{ color: '#dc2626', fontSize: '13px', marginBottom: '8px' }}>{zipError}</div>}

      {loading && <LoadingCats />}
      {error && <div style={{ color: '#dc2626', padding: '16px', background: '#fee2e2', borderRadius: '8px', marginBottom: '16px' }}>{error}</div>}

      {beforeCutoff === true && !loading && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', color: '#92400e' }}>
          <span style={{ fontSize: '18px' }}>🕐</span>
          <span>Идёт приём заказов до <strong>{cutoffTime}</strong> МСК — список может пополняться</span>
        </div>
      )}

      {!loading && !error && (
        <>
          {stores && (
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
              {[
                { label: 'Заказов', value: String(totalOrders) },
                { label: 'Позиций', value: String(totalPositions) },
                { label: 'Выручка', value: totalRevenue.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽' },
                { label: 'Сумма закупа', value: totalSupplier.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽' },
                { label: 'Прибыль', value: totalProfit.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽', color: totalProfit >= 0 ? '#16a34a' : '#dc2626' },
                { label: 'ROS', value: avgRos != null ? (avgRos * 100).toFixed(1) + '%' : '—' },
                { label: 'Средний ROI', value: avgRoi != null ? (avgRoi * 100).toFixed(1) + '%' : '—' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px 18px', minWidth: '110px' }}>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>{label}</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: color ?? '#111827' }}>{value}</div>
                </div>
              ))}
            </div>
          )}

          {activeStores.map((store) => (
            <StoreAssemblyBlock key={store.store_id} store={store} onRefresh={load} />
          ))}
          {stores && activeStores.length === 0 && (
            <div style={{ padding: '32px', textAlign: 'center', color: '#9ca3af', fontSize: '14px' }}>
              {beforeCutoff ? 'Пока нет заказов на сегодня' : 'Нет активных заказов на сегодня'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
