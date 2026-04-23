import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import LoadingCats from '../components/ui/LoadingCats';
import { CACHE_KEYS, clearCache, loadCache, saveCache } from '../utils/pageCache';
import { fetchMatchingStats, fetchSuppliers, zeroAllNoPrice } from '../api/matching';
import { fetchAllStores } from '../api/stores';
import type { Store } from '../types/store';
import {
  applyPriceUpdates,
  confirmAllPriceUpdates,
  fetchApplyStatus,
  fetchPriceUpdates,
  fetchRecalcStatus,
  recalculateStore,
  resetPriceUpdates,
  stopApply,
  stopRecalculate,
  uploadPrices,
  type ApplyProgress,
} from '../api/prices';
import PriceUpdatesTable from '../components/tables/PriceUpdatesTable';
import PromoSyncTable from '../components/tables/PromoSyncTable';
import { exportToXls } from '../utils/exportXls';
import type { PriceUpdate } from '../types/priceUpdate';
import { fetchPromoSyncLog, type PromoSyncEntry } from '../api/prices';

// ─── типы ─────────────────────────────────────────────────────────────────────

type FileEntry = { id: number; file: File | null; supplier: string };

type RecalcResult = {
  storeId: number;
  storeName: string;
  calculated: number;
  no_match: number;
  errors: { sku: string; error: string }[];
};

// ─── вспомогательные ──────────────────────────────────────────────────────────

function SectionCard({
  title,
  headerExtra,
  children,
}: {
  title: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: '24px' }}>
      <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {title}
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '18px', height: '18px', borderRadius: '50%', border: '1.5px solid #9ca3af',
          background: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700,
          color: '#6b7280', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: 1, padding: 0, flexShrink: 0,
        }}
      >
        ?
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '24px', left: '50%', transform: 'translateX(-50%)',
          background: '#1f2937', color: '#f9fafb', fontSize: '12px', lineHeight: '1.6',
          padding: '10px 14px', borderRadius: '8px', zIndex: 100, width: '300px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)', whiteSpace: 'normal', fontWeight: 400,
        }}>
          {text}
          <div style={{
            position: 'absolute', top: '-5px', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
            borderBottom: '5px solid #1f2937',
          }} />
        </div>
      )}
    </span>
  );
}

// ─── страница ─────────────────────────────────────────────────────────────────

type UploadCache = { updates: PriceUpdate[]; recalcResults: RecalcResult[]; skuSearch: string; pendingMatchCount: number; noPriceCount: number };
const UPLOAD_CACHE_KEY = CACHE_KEYS.uploadPrices;

export default function UploadPricesPage() {
  const cached = loadCache<UploadCache>(UPLOAD_CACHE_KEY);

  // загрузка прайсов
  const [entries, setEntries] = useState<FileEntry[]>([{ id: 1, file: null, supplier: '' }]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadResult, setUploadResult] = useState<{
    suppliers: string[];
    rows: number;
    match_stats: { auto_confirmed: number; pending: number };
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const nextId = useRef(2);
  const [pendingMatchCount, setPendingMatchCount] = useState(cached?.pendingMatchCount ?? 0);
  const [noPriceCount, setNoPriceCount] = useState(cached?.noPriceCount ?? 0);
  const [supplierList, setSupplierList] = useState<string[]>([]);

  // пересчёт
  const [recalcResults, setRecalcResults] = useState<RecalcResult[]>(cached?.recalcResults ?? []);
  const [recalcing, setRecalcing] = useState<Record<number, boolean>>({});
  const recalcAbort = useRef<Record<number, AbortController>>({});
  const [noPriceConfirm, setNoPriceConfirm] = useState<{ storeId: number; storeName: string } | null>(null);
  const [zeroingBeforeRecalc, setZeroingBeforeRecalc] = useState(false);
  type RecalcProgress = { done: number; total: number; apiCalls: number } | null;
  const [recalcProgress, setRecalcProgress] = useState<Record<number, RecalcProgress>>({});

  // таблица изменений
  const [updates, setUpdates] = useState<PriceUpdate[]>(cached?.updates ?? []);
  const [skuSearch, setSkuSearch] = useState(cached?.skuSearch ?? '');
  const [loadingUpdates, setLoadingUpdates] = useState(!cached);
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const applyAbort = useRef<AbortController | null>(null);
  const applyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    errors: { sku: string; error: string }[];
  } | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showResetPopup, setShowResetPopup] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [promoLog, setPromoLog] = useState<PromoSyncEntry[]>([]);

  useEffect(() => {
    if (!cached) loadUpdates();
    fetchMatchingStats()
      .then((s) => { setPendingMatchCount(s.pending); setNoPriceCount(s.no_price ?? 0); })
      .catch(() => {});
    fetchSuppliers()
      .then((list) => setSupplierList(list.map((s) => s.supplier)))
      .catch(() => {});

    // Переподключаемся к apply через поллинг (SSE ненадёжен при долгом ожидании)
    fetchApplyStatus().then((s) => {
      if (s.status === 'running') {
        setApplying(true);
        let prevPhase: string | null = null;
        applyPollRef.current = setInterval(async () => {
          try {
            const st = await fetchApplyStatus();
            if (st.phase === 'waiting') {
              setApplyProgress({ type: 'progress', phase: 'waiting', current_store: st.current_store, next_store: st.next_store, wait_remaining: st.wait_remaining, wait_total: st.wait_total, applied: st.applied } as any);
              // Первый магазин применился — обновляем таблицу
              if (prevPhase !== 'waiting') loadUpdates();
            } else if (st.phase) {
              setApplyProgress({ type: 'progress', phase: st.phase as any, current_store: st.current_store, applied: st.applied } as any);
            }
            prevPhase = st.phase;
            if (st.status === 'done' || st.status === 'error' || st.status === 'idle') {
              clearInterval(applyPollRef.current!);
              applyPollRef.current = null;
              setApplying(false);
              setApplyProgress(null);
              if (st.status === 'done' && st.result) {
                setApplyResult(st.result);
                loadUpdates();
                fetchPromoSyncLog().then(setPromoLog).catch(() => {});
                clearCache(CACHE_KEYS.matching, CACHE_KEYS.store('yam16'), CACHE_KEYS.store('yam21'));
              }
            }
          } catch { /* ignore */ }
        }, 3000);
      } else if (s.status === 'done' && s.result) {
        setApplyResult(s.result);
        loadUpdates();
      }
    }).catch(() => {});

    // Загружаем лог акций
    fetchPromoSyncLog().then(setPromoLog).catch(() => {});

    // Загружаем список магазинов и переподключаемся к пересчёту
    fetchAllStores().then((allStores) => {
      setStores(allStores);
      allStores.forEach((store) => {
        const label = store.display_name ?? store.name;
        fetchRecalcStatus(store.id).then((s) => {
          if (s.status === 'running') {
            startRecalc(store.id, label);
          } else if (s.status === 'done' && s.result) {
            setRecalcResults((prev) => [
              ...prev.filter((r) => r.storeId !== store.id),
              { storeId: store.id, storeName: label, ...s.result! },
            ]);
            loadUpdates();
          }
        }).catch(() => {});
      });
    }).catch(() => {});

    return () => {
      if (applyPollRef.current) clearInterval(applyPollRef.current);
    };
  }, []);

  // Сохраняем в кэш при изменениях
  useEffect(() => {
    if (!loadingUpdates) {
      saveCache<UploadCache>(UPLOAD_CACHE_KEY, { updates, recalcResults, skuSearch, pendingMatchCount, noPriceCount });
    }
  }, [updates, recalcResults, skuSearch, pendingMatchCount, noPriceCount, loadingUpdates]);

  async function loadUpdates() {
    setLoadingUpdates(true);
    try {
      setUpdates(await fetchPriceUpdates());
    } catch {
      /* нет данных — не критично */
    } finally {
      setLoadingUpdates(false);
    }
  }

  // ── файлы ──────────────────────────────────────────────────────────────────

  function addEntry() {
    setEntries((prev) => [...prev, { id: nextId.current++, file: null, supplier: '' }]);
  }

  function removeEntry(id: number) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function patchEntry(id: number, patch: Partial<FileEntry>) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  async function handleUpload() {
    const ready = entries.filter((e) => e.file !== null);
    if (ready.length === 0) {
      setUploadError('Выберите хотя бы один файл');
      return;
    }
    const missingSupplier = ready.find((e) => !e.supplier.trim());
    if (missingSupplier) {
      setUploadError('Укажите поставщика для каждого файла');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    setUploadProgress(0);
    try {
      // Перехватываем 100% от XHR — держим на 92 пока обновляем данные
      const progressHandler = (pct: number) => setUploadProgress(pct < 100 ? pct : 92);

      const res = await uploadPrices(
        ready.map((e) => ({ file: e.file!, supplier: e.supplier.trim() })),
        progressHandler,
      );
      setUploadResult(res);
      clearCache(CACHE_KEYS.matching);

      // Стадия «обновление данных»: подтягиваем статы, таблицу изменений и список поставщиков
      setUploadProgress(95);
      await Promise.all([
        fetchMatchingStats()
          .then((s) => { setPendingMatchCount(s.pending); setNoPriceCount(s.no_price ?? 0); })
          .catch(() => {}),
        fetchSuppliers()
          .then((list) => setSupplierList(list.map((s) => s.supplier)))
          .catch(() => {}),
        loadUpdates(),
      ]);

      setUploadProgress(100);
      await new Promise((r) => setTimeout(r, 700));
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  // ── пересчёт ───────────────────────────────────────────────────────────────

  async function startRecalc(storeId: number, storeName: string) {
    const controller = new AbortController();
    recalcAbort.current[storeId] = controller;
    setRecalcing((prev) => ({ ...prev, [storeId]: true }));
    setRecalcProgress((prev) => ({ ...prev, [storeId]: { done: 0, total: 0, apiCalls: 0 } }));

    try {
      const res = await recalculateStore(
        storeId,
        (done, total, apiCalls) => {
          setRecalcProgress((prev) => ({ ...prev, [storeId]: { done, total, apiCalls } }));
        },
        controller.signal,
        true, // force=true: кнопка всегда запускает заново
      );
      setRecalcResults((prev) => [
        ...prev.filter((r) => r.storeId !== storeId),
        { storeId, storeName, ...res },
      ]);
      await loadUpdates();
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') throw e;
      // пользователь нажал Стоп — молча завершаем
    } finally {
      delete recalcAbort.current[storeId];
      setRecalcing((prev) => ({ ...prev, [storeId]: false }));
      setTimeout(() => setRecalcProgress((prev) => ({ ...prev, [storeId]: null })), 800);
    }
  }

  function handleRecalc(storeId: number, storeName: string) {
    if (noPriceCount > 0) {
      setNoPriceConfirm({ storeId, storeName });
    } else {
      startRecalc(storeId, storeName);
    }
  }

  async function handleRecalcZeroFirst(storeId: number, storeName: string) {
    setZeroingBeforeRecalc(true);
    setNoPriceConfirm(null);
    try {
      await zeroAllNoPrice();
      setNoPriceCount(0);
      clearCache(CACHE_KEYS.matching);
    } catch { /* продолжаем в любом случае */ }
    setZeroingBeforeRecalc(false);
    startRecalc(storeId, storeName);
  }

  function handleStopRecalc(storeId: number) {
    stopRecalculate(storeId).catch(() => {});
    recalcAbort.current[storeId]?.abort();
  }

  // @ts-ignore
  async function handleRecalcAll() {
    await Promise.all(stores.map((s) => handleRecalc(s.id, s.display_name ?? s.name)));
  }

  // @ts-ignore
  function handleStopRecalcAll() {
    stores.forEach((s) => handleStopRecalc(s.id));
  }

  // ── применение ─────────────────────────────────────────────────────────────

  async function startApply(force = false) {
    const controller = new AbortController();
    applyAbort.current = controller;
    setApplying(true);
    setApplyResult(null);
    setApplyProgress(null);
    try {
      let prevApplyPhase: string | null = null;
      const res = await applyPriceUpdates(
        (p) => {
          setApplyProgress(p);
          // Первый магазин применился — сразу обновляем таблицу
          if (p.phase === 'waiting' && prevApplyPhase !== 'waiting') loadUpdates();
          prevApplyPhase = p.phase;
        },
        controller.signal,
        undefined,
        force,
      );
      setApplyResult(res);
      await loadUpdates();
      fetchPromoSyncLog().then(setPromoLog).catch(() => {});
      clearCache(CACHE_KEYS.matching, ...stores.map((s) => CACHE_KEYS.store(String(s.id))), CACHE_KEYS.store('yam16'), CACHE_KEYS.store('yam21'));
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') throw e;
    } finally {
      applyAbort.current = null;
      setApplying(false);
      setApplyProgress(null);
    }
  }

  function handleApply() { startApply(true); }
  function handleStopApply() {
    stopApply().catch(() => {});
    applyAbort.current?.abort();
  }

  async function handleConfirmAll() {
    setConfirmingAll(true);
    try {
      await confirmAllPriceUpdates();
      await loadUpdates();
    } finally {
      setConfirmingAll(false);
    }
  }

  async function handleReset(days?: number) {
    setShowResetPopup(false);
    setResetting(true);
    try {
      const res = await resetPriceUpdates(selectedStoreId ?? undefined, days);
      await loadUpdates();
      alert(`Удалено записей: ${res.deleted}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  function handleUpdateConfirmed(updated: PriceUpdate) {
    setUpdates((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
  }

  // @ts-ignore
  const anyRecalcing = Object.values(recalcing).some(Boolean);

  const [priceTab, setPriceTab] = useState<'changes' | 'will_zero' | 'promos'>('changes');
  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);

  // При смене фильтра магазина — перегружаем лог акций
  useEffect(() => {
    fetchPromoSyncLog(selectedStoreId ?? undefined).then(setPromoLog).catch(() => {});
  }, [selectedStoreId]);

  const allFiltered = (() => {
    let result = selectedStoreId != null ? updates.filter((u) => u.store_id === selectedStoreId) : updates;
    if (skuSearch.trim()) result = result.filter((u) => u.sku.toLowerCase().includes(skuSearch.trim().toLowerCase()));
    return result;
  })();

  const filteredUpdates = allFiltered.filter((u) => u.status !== 'will_zero' && u.status !== 'zeroed');
  const willZeroUpdates = allFiltered.filter((u) => u.status === 'will_zero' || u.status === 'zeroed');

  // Уникальных SKU в акциях (последнее действие = ADDED/PRICE_UPDATED)
  const promoActiveSku = (() => {
    const seen = new Set<string>();
    let count = 0;
    for (const r of promoLog) {
      if (!seen.has(r.sku)) {
        seen.add(r.sku);
        if (r.action === 'ADDED' || r.action === 'PRICE_UPDATED') count++;
      }
    }
    return count;
  })();

  const needsConfirmCount = updates.filter(
    (u) => u.requires_confirmation && u.status === 'calculated',
  ).length;
  const readyToApplyCount = updates.filter(
    (u) => !u.requires_confirmation && u.status === 'calculated',
  ).length;

  return (
    <div onClick={() => showResetPopup && setShowResetPopup(false)}>
      <h1 style={{ margin: '0 0 24px' }}>Цены</h1>

      {/* ── 1. Загрузка прайсов ── */}
      <SectionCard title="Загрузка прайсов">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* заголовки колонок */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', paddingLeft: '28px' }}>
            <span style={{ fontSize: '12px', color: '#9ca3af', minWidth: '340px' }}>Файл</span>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>Поставщик</span>
          </div>

          {entries.map((entry, idx) => (
            <FileRow
              key={entry.id}
              index={idx + 1}
              file={entry.file}
              supplier={entry.supplier}
              suppliers={supplierList}
              onFileChange={(f) => patchEntry(entry.id, { file: f })}
              onSupplierChange={(s) => patchEntry(entry.id, { supplier: s })}
              onRemove={entries.length > 1 ? () => removeEntry(entry.id) : undefined}
            />
          ))}

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
            <button
              onClick={addEntry}
              style={{
                padding: '8px 14px',
                fontSize: '13px',
                background: 'transparent',
                border: '1px dashed #9ca3af',
                borderRadius: '6px',
                color: '#6b7280',
                cursor: 'pointer',
              }}
            >
              + Добавить файл
            </button>
            <button className="button" onClick={handleUpload} disabled={uploading}>
              {uploading ? 'Загрузка...' : 'Загрузить'}
            </button>
            {uploadResult && (
              <span style={{ fontSize: '13px', color: '#16a34a' }}>
                Загружено {uploadResult.rows} позиций
              </span>
            )}
            {uploadError && (
              <span style={{ fontSize: '13px', color: '#dc2626' }}>{uploadError}</span>
            )}
          </div>

          {uploadProgress !== null && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>
                <span>
                  {uploadProgress < 90
                    ? 'Отправка файла...'
                    : uploadProgress < 95
                    ? 'Обработка на сервере...'
                    : uploadProgress < 100
                    ? 'Обновление данных...'
                    : 'Готово'}
                </span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="progress-bar">
                <div
                  className={`progress-bar__fill${uploadProgress >= 90 && uploadProgress < 100 ? ' progress-bar__fill--processing' : ''}`}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Баннер: есть pending после загрузки */}
      {uploadResult && uploadResult.match_stats?.pending > 0 && (
        <div
          style={{
            background: '#fef3c7',
            border: '1px solid #fcd34d',
            borderRadius: '10px',
            padding: '14px 18px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
          }}
        >
          <span style={{ fontSize: '14px', color: '#92400e' }}>
            Авто-подтверждено: <strong>{uploadResult.match_stats.auto_confirmed}</strong>.{' '}
            Требуют проверки: <strong>{uploadResult.match_stats.pending}</strong>.
          </span>
          <Link
            to="/matching"
            style={{
              padding: '8px 16px',
              background: '#f59e0b',
              color: 'white',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            Перейти к сопоставлению →
          </Link>
        </div>
      )}

      {/* Баннер: есть no_price — пропали из прайса */}
      {noPriceCount > 0 && (
        <div
          style={{
            background: '#fff7ed',
            border: '1px solid #fed7aa',
            borderLeft: '4px solid #f97316',
            borderRadius: '10px',
            padding: '14px 18px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#9a3412', marginBottom: '2px' }}>
              {noPriceCount} товаров пропали из прайса поставщика
            </div>
            <div style={{ fontSize: '13px', color: '#c2410c' }}>
              По ним нет актуальной цены — нужно принять решение перед пересчётом.
            </div>
          </div>
          <Link
            to="/matching?tab=no_price"
            style={{
              padding: '8px 16px',
              background: '#f97316',
              color: 'white',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
            }}
          >
            Разобраться →
          </Link>
        </div>
      )}

      {/* Баннер: есть pending — несопоставленные */}
      {pendingMatchCount > 0 && (
        <div
          style={{
            background: '#fefce8',
            border: '1px solid #fde68a',
            borderLeft: '4px solid #eab308',
            borderRadius: '10px',
            padding: '14px 18px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#713f12', marginBottom: '2px' }}>
              {pendingMatchCount} позиций поставщика не сопоставлены
            </div>
            <div style={{ fontSize: '13px', color: '#92400e' }}>
              Без сопоставления эти товары не попадут в пересчёт.
            </div>
          </div>
          <Link
            to="/matching?tab=pending"
            style={{
              padding: '8px 16px',
              background: '#eab308',
              color: 'white',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
            }}
          >
            Сопоставить →
          </Link>
        </div>
      )}

      {/* ── 2. Пересчёт цен ── */}
      <SectionCard
        title="Пересчёт цен"
        headerExtra={
          <InfoTooltip text="Для каждого товара делается один запрос к ЯМ API — получаем все издержки (комиссия, доставка, выплата). Затем цена рассчитывается аналитически по формуле. Благодаря кэшу товары в одной категории с похожей ценой вообще не делают запросов к API." />
        }
      >
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
          {stores.map((store) => {
            const id = store.id;
            const name = store.display_name ?? store.name;
            const res = recalcResults.find((r) => r.storeId === id);
            const busy = recalcing[id];
            const progress = recalcProgress[id] ?? null;
            return (
              <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '200px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="button" onClick={() => handleRecalc(id, name)} disabled={busy}>
                    {busy ? 'Считаю...' : `Пересчитать ${name}`}
                  </button>
                  {busy && (
                    <button
                      onClick={() => handleStopRecalc(id)}
                      title="Остановить расчёт"
                      style={{
                        padding: '8px 12px',
                        fontSize: '13px',
                        background: '#fee2e2',
                        color: '#b91c1c',
                        border: '1px solid #fca5a5',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Стоп
                    </button>
                  )}
                </div>

                {progress !== null && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6b7280', marginBottom: '3px' }}>
                      <span>
                        {progress.total > 0
                          ? `${progress.done} / ${progress.total} товаров`
                          : 'Запуск...'}
                      </span>
                      <span style={{ color: '#9ca3af' }}>
                        {progress.apiCalls > 0 ? `${progress.apiCalls} запросов ЯМ` : ''}
                      </span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-bar__fill"
                        style={{
                          width: progress.total > 0
                            ? `${Math.round((progress.done / progress.total) * 100)}%`
                            : '5%',
                          transition: 'width 0.15s ease',
                        }}
                      />
                    </div>
                  </div>
                )}

                {res && progress === null && (
                  <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ color: '#16a34a' }}>✓ {res.calculated} рассчитано</span>
                    {res.no_match > 0 && (
                      <span style={{ color: '#9ca3af' }}>— {res.no_match} без матча</span>
                    )}
                    {res.errors.length > 0 && (
                      <span style={{ color: '#dc2626' }}>✕ {res.errors.length} ошибок</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {noPriceConfirm && (
          <div
            style={{
              marginTop: '16px',
              padding: '14px 16px',
              background: '#fff7ed',
              border: '1px solid #fed7aa',
              borderLeft: '4px solid #f97316',
              borderRadius: '8px',
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#9a3412', marginBottom: '10px' }}>
              {noPriceCount} товаров пропали из прайса — без решения они будут обнулены при применении.
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                className="button"
                disabled={zeroingBeforeRecalc}
                onClick={() => handleRecalcZeroFirst(noPriceConfirm.storeId, noPriceConfirm.storeName)}
                style={{ background: '#f97316', borderColor: '#f97316' }}
              >
                {zeroingBeforeRecalc ? 'Обнуляю...' : `Обнулить ${noPriceCount} и пересчитать`}
              </button>
              <button
                onClick={() => { setNoPriceConfirm(null); startRecalc(noPriceConfirm.storeId, noPriceConfirm.storeName); }}
                style={{
                  padding: '10px 16px', fontSize: '14px', background: 'transparent',
                  border: '1px solid #d1d5db', borderRadius: '8px', cursor: 'pointer', color: '#374151',
                }}
              >
                Пересчитать без обнуления
              </button>
              <button
                onClick={() => setNoPriceConfirm(null)}
                style={{
                  padding: '10px 16px', fontSize: '14px', background: 'transparent',
                  border: 'none', cursor: 'pointer', color: '#9ca3af',
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {pendingMatchCount > 0 && (
          <div
            style={{
              marginTop: '12px',
              fontSize: '13px',
              color: '#b45309',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>⚠</span>
            <span>
              {pendingMatchCount} позиций не сопоставлены — расчёт может быть неполным.{' '}
              <Link to="/matching" style={{ color: '#b45309', fontWeight: 600 }}>
                Сопоставить
              </Link>
            </span>
          </div>
        )}
      </SectionCard>

      {/* ── 3. Изменения цен ── */}
      <SectionCard title="Изменения цен">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
          <button className="button" onClick={handleApply} disabled={applying || readyToApplyCount === 0}>
            {applying
              ? applyProgress?.phase === 'applying_store'
                ? `Применяю ${applyProgress.current_store ?? ''}...`
                : applyProgress?.phase === 'waiting'
                ? `Ожидание...`
                : 'Запуск...'
              : `Применить автоматические (${readyToApplyCount})`}
          </button>
          {applying && (
            <button
              onClick={handleStopApply}
              style={{ padding: '10px 16px', fontSize: '14px', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: '8px', cursor: 'pointer' }}
            >
              Стоп
            </button>
          )}
          {applying && applyProgress?.phase === 'waiting' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '260px' }}>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>
                {applyProgress.current_store} ✓ → ожидание → {applyProgress.next_store}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af' }}>
                <span>До применения {applyProgress.next_store}</span>
                <span>{Math.ceil(applyProgress.wait_remaining / 60)} мин</span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-bar__fill"
                  style={{
                    width: applyProgress.wait_total > 0
                      ? `${Math.round((1 - applyProgress.wait_remaining / applyProgress.wait_total) * 100)}%`
                      : '0%',
                    transition: 'width 3s linear',
                  }}
                />
              </div>
            </div>
          )}
          {needsConfirmCount > 0 && (
            <button
              onClick={handleConfirmAll}
              disabled={confirmingAll}
              style={{ padding: '10px 16px', fontSize: '14px', fontWeight: 600, background: '#f59e0b', color: 'white', border: 'none', borderRadius: '8px', cursor: confirmingAll ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
            >
              {confirmingAll ? 'Подтверждаю...' : `Подтвердить все (${needsConfirmCount})`}
            </button>
          )}
          {applyResult && (
            <span style={{ fontSize: '13px', color: '#16a34a' }}>
              Применено: {applyResult.applied}
              {applyResult.errors.length > 0 && <span style={{ color: '#dc2626' }}>, ошибок: {applyResult.errors.length}</span>}
            </span>
          )}
          <select
            className="select-input"
            value={selectedStoreId ?? ''}
            onChange={(e) => setSelectedStoreId(e.target.value ? Number(e.target.value) : null)}
            style={{ fontSize: '13px', marginLeft: 'auto' }}
          >
            <option value="">Все магазины</option>
            {stores.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.display_name ?? s.name}</option>
            ))}
          </select>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowResetPopup((v) => !v)}
              disabled={resetting}
              style={{ padding: '8px 14px', fontSize: '13px', background: '#fff', border: '1px solid #d1d5db', borderRadius: '8px', cursor: resetting ? 'wait' : 'pointer', color: '#6b7280', whiteSpace: 'nowrap' }}
            >
              {resetting ? 'Сброс...' : 'Сбросить ▾'}
            </button>
            {showResetPopup && (
              <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, marginTop: '4px', background: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 50, minWidth: '180px', overflow: 'hidden' }}>
                {[
                  { label: 'Старше 30 дней', days: 30 },
                  { label: 'Старше 7 дней', days: 7 },
                  { label: 'Старше 1 дня', days: 1 },
                  { label: 'Все записи', days: undefined },
                ].map(({ label, days }) => (
                  <button
                    key={label}
                    onClick={() => handleReset(days)}
                    style={{ display: 'block', width: '100%', padding: '10px 14px', textAlign: 'left', fontSize: '13px', background: 'none', border: 'none', cursor: 'pointer', color: days === undefined ? '#dc2626' : '#374151' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f9fafb')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <input
            type="text"
            value={skuSearch}
            onChange={(e) => setSkuSearch(e.target.value)}
            placeholder="Поиск по SKU…"
            style={{ padding: '8px 12px', fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '8px', width: '180px' }}
          />
          <span style={{ fontSize: '13px', color: '#9ca3af' }}>
            {(skuSearch.trim() || selectedStoreId) ? `${allFiltered.length} / ${updates.length}` : `${updates.length}`} записей
          </span>
        </div>

        {/* вкладки */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <button
            onClick={() => setPriceTab('changes')}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              background: priceTab === 'changes' ? '#374151' : 'transparent',
              color: priceTab === 'changes' ? 'white' : '#6b7280',
              border: '1px solid', borderColor: priceTab === 'changes' ? '#374151' : '#e5e7eb',
              cursor: 'pointer', fontWeight: priceTab === 'changes' ? 600 : 400,
            }}
          >
            Изменения цен
            <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>{filteredUpdates.length}</span>
          </button>
          <button
            onClick={() => setPriceTab('will_zero')}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              background: priceTab === 'will_zero' ? '#374151' : 'transparent',
              color: priceTab === 'will_zero' ? 'white' : willZeroUpdates.length > 0 ? '#dc2626' : '#6b7280',
              border: '1px solid', borderColor: priceTab === 'will_zero' ? '#374151' : willZeroUpdates.length > 0 ? '#fca5a5' : '#e5e7eb',
              cursor: 'pointer', fontWeight: priceTab === 'will_zero' ? 600 : 400,
            }}
          >
            На обнуление
            <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>{willZeroUpdates.length}</span>
          </button>
          <button
            onClick={() => { setPriceTab('promos'); fetchPromoSyncLog(selectedStoreId ?? undefined).then(setPromoLog).catch(() => {}); }}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              background: priceTab === 'promos' ? '#374151' : 'transparent',
              color: priceTab === 'promos' ? 'white' : promoLog.length > 0 ? '#6b7280' : '#6b7280',
              border: '1px solid', borderColor: priceTab === 'promos' ? '#374151' : '#e5e7eb',
              cursor: 'pointer', fontWeight: priceTab === 'promos' ? 600 : 400,
            }}
          >
            Акции{promoActiveSku > 0 && <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>{promoActiveSku}</span>}
          </button>
        </div>

        {loadingUpdates && priceTab !== 'promos' ? (
          <LoadingCats />
        ) : priceTab === 'promos' ? (
          <>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: 0, marginBottom: '12px' }}>
              Изменения вступают в силу через 4–6 часов. Синхронизация включается в настройках каждого магазина.
            </p>
            <PromoSyncTable items={promoLog} />
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
              <button
                onClick={() => {
                  const rows = (priceTab === 'changes' ? filteredUpdates : willZeroUpdates).map((u) => ({
                    'Магазин': (() => { const s = stores.find(x => x.id === u.store_id); return s ? (s.display_name ?? s.name) : String(u.store_id); })(),
                    'SKU': u.sku,
                    'Поставщик': u.supplier ?? '',
                    'Закупка': u.supplier_price ?? '',
                    'Старая цена': u.old_price ?? '',
                    'Новая цена': u.new_price,
                    'Изменение %': u.difference_pct != null ? `${u.difference_pct > 0 ? '+' : ''}${u.difference_pct.toFixed(1)}%` : '',
                    'Прибыль': u.profit ?? '',
                    'ROI': u.actual_roi != null ? `${Math.round(u.actual_roi * 100)}%` : '',
                    'Статус': u.status,
                  }));
                  exportToXls(rows, priceTab === 'changes' ? 'пересчёт_цен' : 'на_обнуление');
                }}
                style={{ padding: '3px 10px', fontSize: '12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px', cursor: 'pointer', color: '#6b7280' }}
              >
                ↓ XLS
              </button>
            </div>
            <PriceUpdatesTable
              items={priceTab === 'changes' ? filteredUpdates : willZeroUpdates}
              onUpdated={handleUpdateConfirmed}
            />
          </>
        )}
      </SectionCard>
    </div>
  );
}

// ─── FileRow ──────────────────────────────────────────────────────────────────

function FileRow({
  index,
  file,
  supplier,
  suppliers,
  onFileChange,
  onSupplierChange,
  onRemove,
}: {
  index: number;
  file: File | null;
  supplier: string;
  suppliers: string[];
  onFileChange: (f: File | null) => void;
  onSupplierChange: (s: string) => void;
  onRemove?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [supplierTouched, setSupplierTouched] = useState(false);
  // Режим: 'select' — выбор из списка, 'new' — ввод нового
  const [mode, setMode] = useState<'select' | 'new'>(() =>
    supplier && !suppliers.includes(supplier) ? 'new' : 'select'
  );

  function typeLabel(name: string) {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return { label: 'PDF', bg: '#fee2e2', color: '#b91c1c' };
    if (ext === 'xlsx' || ext === 'xls') return { label: 'Excel', bg: '#dbeafe', color: '#1d4ed8' };
    return { label: ext?.toUpperCase() ?? '?', bg: '#f3f4f6', color: '#374151' };
  }

  const type = file ? typeLabel(file.name) : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span style={{ fontSize: '13px', color: '#9ca3af', minWidth: '20px' }}>#{index}</span>

      {/* Файл */}
      <div
        onClick={() => inputRef.current?.click()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 12px',
          border: '1px solid #d1d5db',
          borderRadius: '6px',
          cursor: 'pointer',
          background: file ? '#f0fdf4' : '#fff',
          width: '340px',
          userSelect: 'none',
          lineHeight: '1.5',
          fontSize: '14px',
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            fontSize: '14px',
            color: file ? '#111827' : '#9ca3af',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file ? file.name : 'Выберите файл (Excel или PDF)…'}
        </span>
        {type && (
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: '4px',
              background: type.bg,
              color: type.color,
              flexShrink: 0,
            }}
          >
            {type.label}
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
      />

      {/* Поставщик */}
      {mode === 'select' ? (
        <select
          className="select-input"
          value={supplier}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setMode('new');
              onSupplierChange('');
            } else {
              onSupplierChange(e.target.value);
            }
            setSupplierTouched(true);
          }}
          style={{
            width: '220px',
            borderColor: supplierTouched && !supplier ? '#fca5a5' : undefined,
            background: supplierTouched && !supplier ? '#fff7f7' : undefined,
          }}
        >
          <option value="">— Выберите поставщика —</option>
          {suppliers.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
          <option value="__new__">+ Добавить нового поставщика</option>
        </select>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            autoFocus
            type="text"
            value={supplier}
            onChange={(e) => onSupplierChange(e.target.value)}
            onBlur={() => setSupplierTouched(true)}
            placeholder="Название нового поставщика"
            style={{
              padding: '8px 12px',
              border: `1px solid ${supplierTouched && !supplier.trim() ? '#fca5a5' : '#d1d5db'}`,
              borderRadius: '8px',
              fontSize: '13px',
              width: '200px',
              background: supplierTouched && !supplier.trim() ? '#fff7f7' : '#fff',
            }}
          />
          {suppliers.length > 0 && (
            <button
              onClick={() => { setMode('select'); onSupplierChange(''); }}
              title="Выбрать из существующих"
              style={{
                padding: '6px 10px', fontSize: '12px', background: 'transparent',
                border: '1px solid #d1d5db', borderRadius: '6px',
                cursor: 'pointer', color: '#6b7280', whiteSpace: 'nowrap',
              }}
            >
              ← К списку
            </button>
          )}
        </div>
      )}

      {/* Удалить */}
      {onRemove && (
        <button
          onClick={onRemove}
          title="Удалить"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '18px',
            color: '#9ca3af',
            padding: '4px',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
