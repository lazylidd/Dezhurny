import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LoadingCats from '../components/ui/LoadingCats';
import { CACHE_KEYS, clearCache, loadCache, saveCache } from '../utils/pageCache';
import {
  confirmMatch,
  deleteSupplier,
  fetchCandidates,
  fetchMatching,
  fetchMatchingStats,
  fetchSuppliers,
  fetchSupplierSimilar,
  keepOldPrice,
  resetMatch,
  restoreNoPrice,
  stoplistMatch,
  zeroAllNoPrice,
  zeroStockMatch,
  approveAutoMatch,
  rejectAutoMatch,
  fetchSettings,
  updateSettings,
  fetchUnmatchedProducts,
  fetchProductSupplierCandidates,
  confirmSupplierForProduct,
  fetchExportPending,
  fetchExportUnmatchedSkus,
  importSupplierMatches,
  importSkuMatches,
} from '../api/matching';
import type { SupplierSimilar, UnmatchedProduct, SupplierCandidate } from '../api/matching';
import type { Candidate, MatchStats, ProductMatch } from '../types/productMatch';
import { exportToXls } from '../utils/exportXls';
import { fetchAllStores } from '../api/stores';
import type { Store } from '../types/store';

const _STORE_COLORS = [
  { bg: '#eff6ff', text: '#1d4ed8' },
  { bg: '#f0fdf4', text: '#166534' },
  { bg: '#faf5ff', text: '#7e22ce' },
  { bg: '#fff7ed', text: '#c2410c' },
  { bg: '#f0f9ff', text: '#0369a1' },
];
function storeBg(id: number) { return _STORE_COLORS[(id - 1) % _STORE_COLORS.length].bg; }
function storeText(id: number) { return _STORE_COLORS[(id - 1) % _STORE_COLORS.length].text; }

// Module-level store name cache — updated on mount, falls back to id string
let _storeNames: Record<number, string> = {};
function storeNames(id: number): string { return _storeNames[id] ?? String(id); }

function StoreFilterDropdown({ selected, onChange, allStoreIds, storeNames }: {
  selected: Set<number>;
  onChange: (s: Set<number>) => void;
  allStoreIds: number[];
  storeNames: Record<number, string>;
}) {
  const [open, setOpen] = useState(false);

  const label = selected.size === allStoreIds.length
    ? 'Все магазины'
    : selected.size === 0
    ? 'Нет магазинов'
    : Array.from(selected).map((id) => storeNames[id] ?? String(id)).join(', ');

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }

  return (
    <div style={{ position: 'relative' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        style={{
          padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px',
          fontSize: '14px', background: '#fff', cursor: 'pointer', color: '#374151',
          display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
        }}
      >
        {label}
        <span style={{ fontSize: '10px', opacity: 0.5 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 100, minWidth: '160px', padding: '8px 0',
        }}>
          {allStoreIds.map((id) => (
            <label
              key={id}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 16px', cursor: 'pointer', fontSize: '14px',
              }}
            >
              <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
              {storeNames[id] ?? String(id)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierFilterDropdown({ value, suppliers, onChange }: {
  value: string;
  suppliers: { supplier: string; count: number }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const label = value || 'Все поставщики';

  return (
    <div style={{ position: 'relative' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        style={{
          padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px',
          fontSize: '14px', background: '#fff', cursor: 'pointer', color: '#374151',
          display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
        }}
      >
        {label}
        <span style={{ fontSize: '10px', opacity: 0.5 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', zIndex: 100, minWidth: '200px',
          padding: '8px 0', maxHeight: '260px', overflowY: 'auto',
        }}>
          <div
            onClick={() => { onChange(''); setOpen(false); }}
            style={{
              padding: '8px 16px', cursor: 'pointer', fontSize: '14px',
              fontWeight: value === '' ? 600 : 400,
              color: value === '' ? '#2563eb' : '#374151',
            }}
          >
            Все поставщики
          </div>
          {suppliers.map((s) => (
            <div
              key={s.supplier}
              onClick={() => { onChange(s.supplier); setOpen(false); }}
              style={{
                padding: '8px 16px', cursor: 'pointer', fontSize: '14px',
                fontWeight: value === s.supplier ? 600 : 400,
                color: value === s.supplier ? '#2563eb' : '#374151',
              }}
            >
              {s.supplier} <span style={{ color: '#9ca3af', fontSize: '12px' }}>({s.count})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── diff-подсветка ───────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, '').split(/\s+/).filter(Boolean);
}

/** Подсвечивает токены строки относительно reference.
 *  Совпадающие токены → зелёные, несовпадающие → оранжевые. */
function DiffText({ text, reference }: { text: string; reference: string }) {
  const refSet = new Set(tokenize(reference));
  const tokens = text.split(/(\s+)/);
  return (
    <span>
      {tokens.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>;
        const match = refSet.has(part.toLowerCase().replace(/[^а-яёa-z0-9]/gi, ''));
        return (
          <span
            key={i}
            style={{
              background: match ? '#dcfce7' : '#fed7aa',
              color: match ? '#166534' : '#9a3412',
              borderRadius: '3px',
              padding: '0 2px',
            }}
          >
            {part}
          </span>
        );
      })}
    </span>
  );
}

// ─── карточка подтверждения ───────────────────────────────────────────────────

function ConfirmCard({
  candidate,
  supplierName,
  supplierPrice,
  onConfirm,
  onCancel,
  busy,
}: {
  candidate: Candidate;
  supplierName: string;
  supplierPrice: number | null;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        marginTop: '8px',
        padding: '12px 14px',
        background: '#fffbeb',
        border: '1px solid #fcd34d',
        borderRadius: '8px',
        fontSize: '13px',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: '10px', color: '#78350f' }}>
        Подтвердить сопоставление?
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '11px', color: '#9ca3af', minWidth: '80px' }}>Поставщик:</span>
          <DiffText text={supplierName} reference={candidate.product_name} />
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '11px', color: '#9ca3af', minWidth: '80px' }}>
            {storeNames(candidate.store_id)}:
          </span>
          <DiffText text={candidate.product_name} reference={supplierName} />
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
          <span style={{ fontSize: '11px', color: '#9ca3af', minWidth: '80px' }}>SKU:</span>
          <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#374151' }}>
            {candidate.sku}
          </span>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: '4px',
              background: candidate.score >= 0.75 ? '#dcfce7' : candidate.score >= 0.4 ? '#fef3c7' : '#f3f4f6',
              color: candidate.score >= 0.75 ? '#166534' : candidate.score >= 0.4 ? '#92400e' : '#6b7280',
            }}
          >
            {Math.round(candidate.score * 100)}% совпадение
          </span>
        </div>
        {supplierPrice != null && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
            <span style={{ fontSize: '11px', color: '#9ca3af', minWidth: '80px' }}>Цена закупки:</span>
            <span style={{ fontWeight: 600 }}>{supplierPrice.toLocaleString('ru-RU')} ₽</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={onConfirm}
          disabled={busy}
          style={{
            padding: '6px 16px',
            fontSize: '13px',
            background: '#16a34a',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 600,
          }}
        >
          {busy ? 'Сохранение...' : 'Подтвердить'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: '6px 14px',
            fontSize: '13px',
            background: 'transparent',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            cursor: 'pointer',
            color: '#374151',
          }}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(price: number | null) {
  if (price == null) return '—';
  return price.toLocaleString('ru-RU') + ' ₽';
}

function TabBtn({
  label, count, active, warn, onClick,
}: { label: string; count: number; active: boolean; warn?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 18px', fontSize: '14px',
        fontWeight: active ? 700 : 400,
        background: active ? '#2563eb' : 'transparent',
        color: active ? 'white' : '#374151',
        border: '1px solid', borderColor: active ? '#2563eb' : '#e5e7eb',
        borderRadius: '8px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '8px',
      }}
    >
      {label}
      <span style={{
        background: active ? 'rgba(255,255,255,0.25)' : warn && count > 0 ? '#ef4444' : '#e5e7eb',
        color: active ? 'white' : warn && count > 0 ? 'white' : '#6b7280',
        borderRadius: '999px', padding: '1px 8px', fontSize: '12px', fontWeight: 700,
      }}>
        {count}
      </span>
    </button>
  );
}

// ─── строка pending ───────────────────────────────────────────────────────────

function PendingRow({
  match, onConfirmed, onStoplisted,
}: {
  match: ProductMatch;
  onConfirmed: (id: number, sku: string, storeName: string, productName: string) => void;
  onStoplisted: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [pendingCandidate, setPendingCandidate] = useState<Candidate | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCandidates(match.id)
      .then((res) => { if (!cancelled) setCandidates(res); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingCandidates(false); });
    return () => { cancelled = true; };
  }, [match.id]);

  useEffect(() => {
    if (searchMode) setTimeout(() => inputRef.current?.focus(), 50);
  }, [searchMode]);

  const displayCandidates = searchMode
    ? candidates.filter((c) => {
        const lq = query.toLowerCase();
        return !lq || c.product_name.toLowerCase().includes(lq) || c.sku.toLowerCase().includes(lq);
      })
    : candidates.slice(0, 3);

  async function handleConfirm() {
    if (!pendingCandidate) return;
    setBusy(true);
    try {
      await confirmMatch(match.id, pendingCandidate.sku, pendingCandidate.store_id);
      onConfirmed(match.id, pendingCandidate.sku, storeNames(pendingCandidate.store_id), pendingCandidate.product_name);
    } finally {
      setBusy(false);
      setPendingCandidate(null);
    }
  }

  async function handleStoplist() {
    setBusy(true);
    try {
      await stoplistMatch(match.id);
      onStoplisted(match.id);
    } finally {
      setBusy(false);
    }
  }

  function selectCandidate(c: Candidate) {
    setPendingCandidate(c);
    setSearchMode(false);
    setQuery('');
  }

  return (
    <tr style={{ verticalAlign: 'top' }}>
      <td style={{ maxWidth: '240px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontWeight: 500, fontSize: '13px', lineHeight: '1.4' }}>{match.supplier_name}</span>
          {match.best_score != null && (
            <span style={{
              fontSize: '11px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', flexShrink: 0,
              background: match.best_score >= 0.75 ? '#dcfce7' : match.best_score >= 0.4 ? '#fef3c7' : '#f3f4f6',
              color: match.best_score >= 0.75 ? '#166534' : match.best_score >= 0.4 ? '#92400e' : '#6b7280',
            }}>
              {Math.round(match.best_score * 100)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>{match.supplier}</div>
      </td>

      <td style={{ color: '#374151', fontSize: '13px' }}>{fmt(match.supplier_price)}</td>

      <td style={{ minWidth: '380px' }}>
        {loadingCandidates ? (
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>Загрузка...</span>
        ) : pendingCandidate ? (
          <ConfirmCard
            candidate={pendingCandidate}
            supplierName={match.supplier_name}
            supplierPrice={match.supplier_price}
            onConfirm={handleConfirm}
            onCancel={() => setPendingCandidate(null)}
            busy={busy}
          />
        ) : !searchMode ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {candidates.length === 0 ? (
              <span style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>
                Кандидаты не найдены
              </span>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {displayCandidates.map((c) => (
                  <button
                    key={c.sku + c.store_id}
                    onClick={() => selectCandidate(c)}
                    disabled={busy}
                    title={`${storeNames(c.store_id)} · ${c.sku}`}
                    style={{
                      padding: '4px 10px', fontSize: '12px',
                      background: '#f0f9ff', border: '1px solid #bae6fd',
                      borderRadius: '6px', cursor: 'pointer', color: '#0369a1',
                      maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', textAlign: 'left',
                    }}
                  >
                    <span style={{ opacity: 0.6, marginRight: '4px', fontSize: '11px' }}>
                      {Math.round(c.score * 100)}%
                    </span>
                    <span style={{ color: '#6b7280', marginRight: '4px', fontSize: '11px' }}>
                      {storeNames(c.store_id)}
                    </span>
                    {c.product_name}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => setSearchMode(true)}
              style={{
                alignSelf: 'flex-start', fontSize: '12px', color: '#6b7280',
                background: 'none', border: 'none', cursor: 'pointer', padding: '0',
                textDecoration: 'underline',
              }}
            >
              Найти другой…
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по SKU или названию…"
              style={{
                padding: '6px 10px', border: '1px solid #d1d5db',
                borderRadius: '6px', fontSize: '13px', width: '100%',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
              {displayCandidates.length === 0 && (
                <span style={{ fontSize: '12px', color: '#9ca3af', padding: '4px 0' }}>Ничего не найдено</span>
              )}
              {displayCandidates.map((c) => (
                <div
                  key={c.sku + c.store_id}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 8px', borderRadius: '6px', background: '#f9fafb',
                    fontSize: '12px', gap: '8px',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{
                      display: 'inline-block', minWidth: '32px', marginRight: '6px',
                      fontWeight: 700,
                      color: c.score >= 0.75 ? '#16a34a' : c.score >= 0.4 ? '#b45309' : '#6b7280',
                    }}>
                      {Math.round(c.score * 100)}%
                    </span>
                    <span style={{ color: '#6b7280', marginRight: '6px' }}>{storeNames(c.store_id)}</span>
                    {c.product_name}
                    <span style={{ color: '#9ca3af', marginLeft: '6px' }}>{c.sku}</span>
                  </span>
                  <button
                    onClick={() => selectCandidate(c)}
                    disabled={busy}
                    style={{
                      padding: '3px 10px', fontSize: '12px', background: '#2563eb',
                      color: 'white', border: 'none', borderRadius: '5px',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    Выбрать
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => { setSearchMode(false); setQuery(''); }}
              style={{ alignSelf: 'flex-start', fontSize: '12px', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
            >
              ← Назад
            </button>
          </div>
        )}
      </td>

      <td>
        <button
          onClick={handleStoplist}
          disabled={busy || !!pendingCandidate}
          style={{
            padding: '5px 12px', fontSize: '12px', background: 'transparent',
            border: '1px solid #e5e7eb', borderRadius: '6px',
            cursor: busy ? 'wait' : 'pointer', color: '#6b7280', whiteSpace: 'nowrap',
          }}
        >
          В стоп-лист
        </button>
      </td>
    </tr>
  );
}

// ─── вкладка Pending ──────────────────────────────────────────────────────────

type PendingSort = 'score_desc' | 'name_asc' | 'name_desc';

function PendingTab({
  items, onConfirmed, onStoplisted,
}: {
  items: ProductMatch[];
  onConfirmed: (id: number, sku: string, storeName: string, productName: string) => void;
  onStoplisted: (id: number) => void;
}) {
  const [sort, setSort] = useState<PendingSort>('score_desc');

  const sorted = [...items].sort((a, b) => {
    if (sort === 'score_desc') return (b.best_score ?? -1) - (a.best_score ?? -1);
    const cmp = a.supplier_name.localeCompare(b.supplier_name, 'ru');
    return sort === 'name_asc' ? cmp : -cmp;
  });

  if (items.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>
        Все позиции сопоставлены. Загрузите прайс для обновления.
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>
              <span
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setSort(sort === 'name_asc' ? 'name_desc' : 'name_asc')}
              >
                Товар поставщика{' '}
                <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                  {sort === 'name_asc' ? '▲' : sort === 'name_desc' ? '▼' : '↕'}
                </span>
              </span>
            </th>
            <th>Цена закупки</th>
            <th>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>Кандидаты для сопоставления</span>
                <button
                  onClick={() => setSort('score_desc')}
                  style={{
                    padding: '2px 8px', fontSize: '11px',
                    background: sort === 'score_desc' ? '#2563eb' : 'transparent',
                    color: sort === 'score_desc' ? 'white' : '#6b7280',
                    border: `1px solid ${sort === 'score_desc' ? '#2563eb' : '#d1d5db'}`,
                    borderRadius: '4px', cursor: 'pointer',
                    fontWeight: sort === 'score_desc' ? 700 : 400,
                  }}
                >
                  Лучшие вверх ▼
                </button>
              </div>
            </th>
            <th>Действие</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <PendingRow key={m.id} match={m} onConfirmed={onConfirmed} onStoplisted={onStoplisted} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── вкладка Confirmed ────────────────────────────────────────────────────────

function ConfirmedTab({ items, onReset }: { items: ProductMatch[]; onReset: (id: number) => void }) {
  if (items.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Нет сопоставленных позиций.</div>;
  }
  const now = Date.now();
  const sorted = [...items].sort((a, b) => {
    const aNew = a.confirmed_at && (now - new Date(a.confirmed_at).getTime()) < 10 * 60 * 1000;
    const bNew = b.confirmed_at && (now - new Date(b.confirmed_at).getTime()) < 10 * 60 * 1000;
    if (aNew && !bNew) return -1;
    if (!aNew && bNew) return 1;
    return 0;
  });
  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>Товар поставщика</th>
            <th>Поставщик</th>
            <th>Цена закупки</th>
            <th>Актуальность</th>
            <th>Магазин</th>
            <th>SKU в магазине</th>
            <th>Название в магазине</th>
            <th>Тип</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => <ConfirmedRow key={m.id} match={m} onReset={onReset} />)}
        </tbody>
      </table>
    </div>
  );
}

function ConfirmedRow({ match: m, onReset }: { match: ProductMatch; onReset: (id: number) => void }) {
  const [busy, setBusy] = useState(false);

  async function handleReset() {
    setBusy(true);
    try { await resetMatch(m.id); onReset(m.id); } finally { setBusy(false); }
  }

  const isAwaiting = m.status === 'awaiting_price';
  const isCurrent = !isAwaiting && m.price_is_current !== false;
  const isNew = m.confirmed_at
    ? (Date.now() - new Date(m.confirmed_at).getTime()) < 10 * 60 * 1000
    : false;

  return (
    <tr style={{ opacity: isAwaiting ? 0.6 : isCurrent ? 1 : 0.75, background: isNew ? '#fefce8' : undefined }}>
      <td style={{ fontSize: '13px', maxWidth: '200px' }}>{m.supplier_name}</td>
      <td style={{ fontSize: '12px', color: '#6b7280' }}>{m.supplier}</td>
      <td style={{ fontSize: '13px' }}>{isAwaiting ? '—' : fmt(m.supplier_price)}</td>
      <td>
        {isAwaiting ? (
          <span style={{
            fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: '#f3f4f6', color: '#6b7280',
          }}
            title="Обнулён, ждём возврата позиции в прайс поставщика"
          >
            ждёт прайса
          </span>
        ) : isCurrent ? (
          <span style={{
            fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: '#f0fdf4', color: '#16a34a',
          }}>
            актуальная
          </span>
        ) : (
          <span style={{
            fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: '#fef3c7', color: '#92400e',
          }}
            title="Позиция поставщика не найдена в последнем загруженном прайсе"
          >
            нет в прайсе
          </span>
        )}
      </td>
      <td>
        {m.store_id != null ? (
          <span style={{
            fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: storeBg(m.store_id ?? 1),
            color: storeText(m.store_id ?? 1),
          }}>
            {storeNames(m.store_id ?? 0)}
          </span>
        ) : '—'}
      </td>
      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{m.sku ?? '—'}</td>
      <td style={{ fontSize: '13px', maxWidth: '200px' }}>{m.product_name ?? '—'}</td>
      <td>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
            background: m.match_type === 'auto' ? '#f0fdf4' : '#eff6ff',
            color: m.match_type === 'auto' ? '#166534' : '#1d4ed8',
          }}>
            {m.match_type === 'auto' ? 'авто' : 'вручную'}
          </span>
          {isNew && (
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
              background: '#fef08a', color: '#713f12',
            }}>
              новый
            </span>
          )}
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button onClick={handleReset} disabled={busy} style={{
            padding: '4px 10px', fontSize: '12px', background: 'none',
            border: '1px solid #e5e7eb', borderRadius: '6px',
            cursor: busy ? 'wait' : 'pointer', color: '#6b7280',
          }}>
            Отвязать
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── вкладка Stoplist ─────────────────────────────────────────────────────────

// ─── вкладка На проверке (auto_review) ───────────────────────────────────────

function AutoReviewTab({
  items,
  onApproved,
  onRejected,
}: {
  items: ProductMatch[];
  onApproved: (id: number) => void;
  onRejected: (id: number) => void;
}) {
  if (items.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Нет предложений на проверке.</div>;
  }
  return (
    <div className="table-wrapper">
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#92400e', background: '#fef3c7', padding: '8px 12px', borderRadius: '6px' }}>
        Авто-матчинг предложил эти пары — проверьте и подтвердите или отклоните каждую.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Товар поставщика</th>
            <th>Поставщик</th>
            <th>Цена закупки</th>
            <th>Магазин</th>
            <th>SKU</th>
            <th>Товар в магазине</th>
            <th>Сходство</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <AutoReviewRow key={m.id} match={m} onApproved={onApproved} onRejected={onRejected} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AutoReviewRow({
  match: m,
  onApproved,
  onRejected,
}: {
  match: ProductMatch;
  onApproved: (id: number) => void;
  onRejected: (id: number) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  async function handleApprove() {
    setBusy('approve');
    try { await approveAutoMatch(m.id); onApproved(m.id); } finally { setBusy(null); }
  }

  async function handleReject() {
    setBusy('reject');
    try { await rejectAutoMatch(m.id); onRejected(m.id); } finally { setBusy(null); }
  }

  return (
    <tr style={{ background: '#fffbeb' }}>
      <td style={{ fontSize: '13px', maxWidth: '200px' }}>{m.supplier_name}</td>
      <td style={{ fontSize: '12px', color: '#6b7280' }}>{m.supplier}</td>
      <td style={{ fontSize: '13px' }}>{fmt(m.supplier_price)}</td>
      <td>
        {m.store_id != null ? (
          <span style={{
            fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: storeBg(m.store_id ?? 1),
            color: storeText(m.store_id ?? 1),
          }}>
            {storeNames(m.store_id ?? 0)}
          </span>
        ) : '—'}
      </td>
      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>{m.sku ?? '—'}</td>
      <td style={{ fontSize: '13px', maxWidth: '200px' }}>
        {m.supplier_name && m.product_name ? (
          <DiffText text={m.product_name} reference={m.supplier_name} />
        ) : (m.product_name ?? '—')}
      </td>
      <td>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {m.match_type === 'exact' ? (
            <span style={{
              fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
              background: '#dcfce7', color: '#166534',
            }}>
              точное ✓
            </span>
          ) : (
            <span style={{ fontSize: '12px', color: '#92400e', fontWeight: 600 }}>
              {m.best_score != null ? `${Math.round(m.best_score * 100)}%` : '—'}
            </span>
          )}
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={handleApprove}
            disabled={busy !== null}
            style={{
              padding: '4px 10px', fontSize: '12px', borderRadius: '6px',
              border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534',
              cursor: busy !== null ? 'wait' : 'pointer', fontWeight: 600,
            }}
          >
            {busy === 'approve' ? '...' : 'Подтвердить'}
          </button>
          <button
            onClick={handleReject}
            disabled={busy !== null}
            style={{
              padding: '4px 10px', fontSize: '12px', borderRadius: '6px',
              border: '1px solid #fca5a5', background: '#fff', color: '#dc2626',
              cursor: busy !== null ? 'wait' : 'pointer',
            }}
          >
            {busy === 'reject' ? '...' : 'Отклонить'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function StoplistTab({ items, onRestored }: { items: ProductMatch[]; onRestored: (id: number) => void }) {
  if (items.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Стоп-лист пуст.</div>;
  }
  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>Товар поставщика</th><th>Поставщик</th><th>Цена закупки</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => <StoplistRow key={m.id} match={m} onRestored={onRestored} />)}
        </tbody>
      </table>
    </div>
  );
}

function StoplistRow({ match: m, onRestored }: { match: ProductMatch; onRestored: (id: number) => void }) {
  const [busy, setBusy] = useState(false);

  async function handleRestore() {
    setBusy(true);
    try { await resetMatch(m.id); onRestored(m.id); } finally { setBusy(false); }
  }

  return (
    <tr style={{ opacity: 0.7 }}>
      <td style={{ fontSize: '13px' }}>{m.supplier_name}</td>
      <td style={{ fontSize: '12px', color: '#6b7280' }}>{m.supplier}</td>
      <td style={{ fontSize: '13px' }}>{fmt(m.supplier_price)}</td>
      <td>
        <button onClick={handleRestore} disabled={busy} style={{
          padding: '4px 10px', fontSize: '12px', background: 'none',
          border: '1px solid #e5e7eb', borderRadius: '6px',
          cursor: busy ? 'wait' : 'pointer', color: '#6b7280',
        }}>
          Восстановить
        </button>
      </td>
    </tr>
  );
}

// ─── вкладка NoPrice ──────────────────────────────────────────────────────────

// ─── вкладка Ждут прайса ──────────────────────────────────────────────────────

function AwaitingTab({ items, onRestored }: { items: ProductMatch[]; onRestored: (id: number) => void }) {
  if (items.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Нет товаров, ожидающих прайса.</div>;
  }
  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>Магазин</th>
            <th>SKU</th>
            <th>Название в магазине</th>
            <th>Поставщик</th>
            <th>Последняя цена</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <AwaitingRow key={m.id} match={m} onRestored={onRestored} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AwaitingRow({ match: m, onRestored }: { match: ProductMatch; onRestored: (id: number) => void }) {
  const [busy, setBusy] = useState(false);

  async function handleRestore() {
    setBusy(true);
    try { await restoreNoPrice(m.id); onRestored(m.id); } finally { setBusy(false); }
  }

  return (
    <tr style={{ opacity: 0.7 }}>
      <td>
        {m.store_id != null && (
          <span style={{
            fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
            background: storeBg(m.store_id ?? 1),
            color: storeText(m.store_id ?? 1),
          }}>
            {storeNames(m.store_id ?? 0)}
          </span>
        )}
      </td>
      <td style={{ fontFamily: 'monospace', fontSize: '12px', color: '#6b7280' }}>{m.sku ?? '—'}</td>
      <td style={{ fontSize: '13px' }}>{m.product_name ?? '—'}</td>
      <td style={{ fontSize: '12px', color: '#6b7280' }}>{m.supplier} — {m.supplier_name}</td>
      <td style={{ fontSize: '13px', color: '#9ca3af' }}>{fmt(m.supplier_price)}</td>
      <td>
        <button onClick={handleRestore} disabled={busy} style={{
          padding: '4px 10px', fontSize: '12px', background: 'none',
          border: '1px solid #e5e7eb', borderRadius: '6px',
          cursor: busy ? 'wait' : 'pointer', color: '#6b7280', whiteSpace: 'nowrap',
        }}>
          Вернуть к решению
        </button>
      </td>
    </tr>
  );
}

// ─── вкладка Пропали из прайса ────────────────────────────────────────────────

const NP_COLS = [
  { key: 'store',   label: 'Магазин / SKU',            defaultW: 180 },
  { key: 'name',    label: 'Название в магазине',       defaultW: 220 },
  { key: 'supplier',label: 'Прежний поставщик / цена', defaultW: 190 },
  { key: 'action',  label: 'Решение',                  defaultW: 180 },
  { key: 'similar', label: 'Похожие в текущем прайсе', defaultW: 400 },
] as const;
type NpColKey = typeof NP_COLS[number]['key'];

function NoPriceResizeHandle({ onResize }: { onResize: (d: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    startX.current = e.clientX;
    function onMove(ev: MouseEvent) { onResize(ev.clientX - startX.current); startX.current = ev.clientX; }
    function onUp() { setDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  return (
    <span onMouseDown={onMouseDown} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '5px', cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
      <span style={{ width: '2px', height: '60%', borderRadius: '1px', background: dragging ? '#2563eb' : '#d1d5db', transition: 'background 0.15s' }} />
    </span>
  );
}

const NP_WIDTHS_LS = 'np_table_widths_v1';

function loadNpWidths(): Record<NpColKey, number> {
  const defaults = Object.fromEntries(NP_COLS.map(c => [c.key, c.defaultW])) as Record<NpColKey, number>;
  try {
    const raw = localStorage.getItem(NP_WIDTHS_LS);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {}
  return defaults;
}

function NoPriceTab({
  items,
  onKept,
  onZeroed,
  onZeroedAll,
}: {
  items: ProductMatch[];
  onKept: (id: number) => void;
  onZeroed: (id: number) => void;
  onZeroedAll: () => Promise<void>;
}) {
  const [widths, setWidths] = useState<Record<NpColKey, number>>(loadNpWidths);
  const [busyAll, setBusyAll] = useState(false);

  function resize(key: NpColKey, delta: number) {
    setWidths(prev => {
      const next = { ...prev, [key]: Math.max(80, prev[key] + delta) };
      localStorage.setItem(NP_WIDTHS_LS, JSON.stringify(next));
      return next;
    });
  }

  async function handleZeroAll() {
    setBusyAll(true);
    try { await onZeroedAll(); } finally { setBusyAll(false); }
  }

  const totalW = NP_COLS.reduce((s, c) => s + widths[c.key], 0);

  if (items.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Нет товаров, пропавших из прайса.</div>;
  }
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <button
          onClick={handleZeroAll}
          disabled={busyAll}
          style={{
            padding: '8px 16px', fontSize: '13px', fontWeight: 600,
            background: busyAll ? '#f3f4f6' : '#fff', color: '#b91c1c',
            border: '1px solid #fca5a5', borderRadius: '8px',
            cursor: busyAll ? 'wait' : 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {busyAll ? 'Обнуляю...' : `Обнулить все (${items.length})`}
        </button>
      </div>
    <div className="table-wrapper">
      <table className="table" style={{ tableLayout: 'fixed', width: `${totalW}px` }}>
        <colgroup>
          {NP_COLS.map(c => <col key={c.key} style={{ width: `${widths[c.key]}px` }} />)}
        </colgroup>
        <thead>
          <tr>
            {NP_COLS.map(c => (
              <th key={c.key} style={{ position: 'relative', userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.label}
                <NoPriceResizeHandle onResize={d => resize(c.key, d)} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <NoPriceRow key={m.id} match={m} onKept={onKept} onZeroed={onZeroed} />
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function NoPriceRow({
  match: m,
  onKept,
  onZeroed,
}: {
  match: ProductMatch;
  onKept: (id: number) => void;
  onZeroed: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [manualPrice, setManualPrice] = useState('');
  const [similar, setSimilar] = useState<SupplierSimilar[]>([]);
  const [loadingSimilar, setLoadingSimilar] = useState(true);

  useEffect(() => {
    fetchSupplierSimilar(m.id)
      .then(setSimilar)
      .catch(() => {})
      .finally(() => setLoadingSimilar(false));
  }, [m.id]);

  const priceToUse = manualPrice.trim() !== '' ? parseFloat(manualPrice) : null;
  const hasManualPrice = priceToUse != null && !isNaN(priceToUse) && priceToUse > 0;

  async function handleKeep(price?: number) {
    setBusy(true);
    try {
      await keepOldPrice(m.id, price ?? (hasManualPrice ? priceToUse! : undefined));
      onKept(m.id);
    } finally { setBusy(false); }
  }

  async function handleZero() {
    if (!confirm(`Обнулить остаток для «${m.product_name ?? m.sku ?? m.supplier_name}» в ЯМ и убрать в стоп-лист?`)) return;
    setBusy(true);
    try { await zeroStockMatch(m.id); onZeroed(m.id); } finally { setBusy(false); }
  }

  // порядок колонок: store | name | supplier | action | similar
  return (
    <tr style={{ verticalAlign: 'top', background: '#fffbeb' }}>

      {/* 1. Магазин + SKU */}
      <td>
        {m.store_id != null && (
          <div style={{ marginBottom: '4px' }}>
            <span style={{
              fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
              background: storeBg(m.store_id ?? 1),
              color: storeText(m.store_id ?? 1),
            }}>
              {storeNames(m.store_id ?? 0)}
            </span>
          </div>
        )}
        <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {m.sku ?? '—'}
        </div>
      </td>

      {/* 2. Название в магазине */}
      <td style={{ overflow: 'hidden' }}>
        <div style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.product_name ?? '—'}</div>
      </td>

      {/* 3. Прежний поставщик / цена */}
      <td style={{ overflow: 'hidden' }}>
        <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.supplier}</div>
        <div style={{ fontSize: '12px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.supplier_name}</div>
        <div style={{ fontSize: '12px', color: '#374151', marginTop: '3px' }}>
          {fmt(m.supplier_price)}
          <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '4px' }}>устаревшая</span>
        </div>
      </td>

      {/* 4. Решение */}
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
          <input
            type="number"
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            placeholder="Своя цена"
            style={{
              width: '90px', padding: '3px 6px', fontSize: '12px',
              border: '1px solid #d1d5db', borderRadius: '4px', background: '#fff',
            }}
          />
          <span style={{ fontSize: '11px', color: '#9ca3af' }}>₽</span>
        </div>
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          <button
            onClick={() => handleKeep()}
            disabled={busy}
            style={{
              padding: '4px 10px', fontSize: '12px', background: 'white',
              border: '1px solid #d1d5db', borderRadius: '6px',
              cursor: busy ? 'wait' : 'pointer', color: '#374151', whiteSpace: 'nowrap',
            }}
          >
            {hasManualPrice ? 'Сохранить' : 'Оставить'}
          </button>
          <button
            onClick={handleZero}
            disabled={busy}
            style={{
              padding: '4px 10px', fontSize: '12px', background: 'white',
              border: '1px solid #d1d5db', borderRadius: '6px',
              cursor: busy ? 'wait' : 'pointer', color: '#6b7280', whiteSpace: 'nowrap',
            }}
          >
            Обнулить
          </button>
        </div>
      </td>

      {/* 5. Похожие из прайса */}
      <td>
        {loadingSimilar ? (
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>Поиск…</span>
        ) : similar.length === 0 ? (
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {similar.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderRadius: '5px', background: '#f9fafb', borderLeft: '3px solid #d1d5db' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, flexShrink: 0, color: s.score >= 0.7 ? '#374151' : '#9ca3af', minWidth: '28px' }}>
                  {Math.round(s.score * 100)}%
                </span>
                <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#374151' }}>
                  <DiffText text={s.name} reference={m.supplier_name} />
                </span>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#374151', flexShrink: 0 }}>
                  {s.price.toLocaleString('ru-RU')} ₽
                </span>
                <button
                  onClick={() => handleKeep(s.price)}
                  disabled={busy}
                  style={{
                    padding: '2px 8px', fontSize: '11px', flexShrink: 0,
                    background: 'white', color: '#374151', border: '1px solid #d1d5db',
                    borderRadius: '4px', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  Принять
                </button>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── вкладка SKU магазинов ────────────────────────────────────────────────────

function StoreSkuRow({
  product,
  onConfirmed,
}: {
  product: UnmatchedProduct;
  onConfirmed: () => void;
}) {
  const [candidates, setCandidates] = useState<SupplierCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingCandidate, setPendingCandidate] = useState<SupplierCandidate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProductSupplierCandidates(product.store_id, product.sku)
      .then((res) => { if (!cancelled) setCandidates(res); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [product.store_id, product.sku]);

  async function handleConfirm() {
    if (!pendingCandidate) return;
    setBusy(true);
    try {
      await confirmSupplierForProduct(product.store_id, product.sku, pendingCandidate.supplier, pendingCandidate.supplier_normalized);
      onConfirmed();
    } finally {
      setBusy(false);
      setPendingCandidate(null);
    }
  }

  const top3 = candidates.slice(0, 3);

  return (
    <tr style={{ verticalAlign: 'top' }}>
      <td>
        <span style={{
          fontSize: '12px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
          background: storeBg(product.store_id ?? 1),
          color: storeText(product.store_id ?? 1),
        }}>
          {storeNames(product.store_id ?? 0)}
        </span>
      </td>
      <td style={{ fontFamily: 'monospace', fontSize: '12px', color: '#374151' }}>{product.sku}</td>
      <td style={{ fontSize: '13px', maxWidth: '200px' }}>{product.name ?? '—'}</td>
      <td style={{ fontSize: '13px' }}>{product.price != null ? product.price.toLocaleString('ru-RU') + ' ₽' : '—'}</td>
      <td style={{ minWidth: '340px' }}>
        {pendingCandidate ? (
          <div style={{ padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: '8px', fontSize: '13px' }}>
            <div style={{ fontWeight: 700, marginBottom: '8px', color: '#78350f' }}>Подтвердить?</div>
            <div style={{ marginBottom: '4px' }}>
              <span style={{ color: '#9ca3af', fontSize: '11px' }}>Поставщик: </span>
              <DiffText text={pendingCandidate.supplier_name} reference={product.name ?? ''} />
            </div>
            <div style={{ marginBottom: '4px' }}>
              <span style={{ color: '#9ca3af', fontSize: '11px' }}>Цена: </span>
              <strong>{pendingCandidate.supplier_price.toLocaleString('ru-RU')} ₽</strong>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button
                onClick={handleConfirm}
                disabled={busy}
                style={{ padding: '5px 14px', fontSize: '12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', cursor: busy ? 'wait' : 'pointer', fontWeight: 600 }}
              >
                {busy ? '...' : 'Подтвердить'}
              </button>
              <button
                onClick={() => setPendingCandidate(null)}
                disabled={busy}
                style={{ padding: '5px 12px', fontSize: '12px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', color: '#374151' }}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : loading ? (
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>Загрузка…</span>
        ) : candidates.length === 0 ? (
          <span style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>Кандидаты не найдены</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {top3.map((c, i) => (
              <button
                key={i}
                onClick={() => setPendingCandidate(c)}
                title={`${c.supplier} · ${c.supplier_price.toLocaleString('ru-RU')} ₽`}
                style={{
                  padding: '4px 10px', fontSize: '12px',
                  background: c.match_status === 'confirmed' ? '#f0fdf4' : '#f0f9ff',
                  border: `1px solid ${c.match_status === 'confirmed' ? '#bbf7d0' : '#bae6fd'}`,
                  borderRadius: '6px', cursor: 'pointer',
                  color: c.match_status === 'confirmed' ? '#166534' : '#0369a1',
                  maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', textAlign: 'left',
                }}
              >
                <span style={{ opacity: 0.6, marginRight: '4px', fontSize: '11px' }}>{Math.round(c.score * 100)}%</span>
                <span style={{ color: '#6b7280', marginRight: '4px', fontSize: '11px' }}>{c.supplier}</span>
                {c.supplier_name}
              </button>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function StoreSkusTab({
  onMatchConfirmed,
  onCountLoaded,
}: {
  onMatchConfirmed: () => void;
  onCountLoaded?: (count: number) => void;
}) {
  const [products, setProducts] = useState<UnmatchedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmedSkus, setConfirmedSkus] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchUnmatchedProducts()
      .then((data) => { setProducts(data); onCountLoaded?.(data.length); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleConfirmed(storeId: number, sku: string) {
    setConfirmedSkus((prev) => new Set([...prev, `${storeId}__${sku}`]));
    onMatchConfirmed();
  }

  const visible = products.filter((p) => !confirmedSkus.has(`${p.store_id}__${p.sku}`));

  if (loading) return <LoadingCats />;

  if (visible.length === 0) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#6b7280' }}>Все SKU магазинов сопоставлены.</div>;
  }

  return (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>Магазин</th>
            <th>SKU</th>
            <th>Название</th>
            <th>Цена в магазине</th>
            <th>Кандидаты поставщика</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <StoreSkuRow
              key={`${p.store_id}__${p.sku}`}
              product={p}
              onConfirmed={() => handleConfirmed(p.store_id, p.sku)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── панель управления поставщиками ──────────────────────────────────────────

function SuppliersPanel({
  suppliers, onDeleted,
}: {
  suppliers: { supplier: string; count: number }[];
  onDeleted: (supplier: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (suppliers.length === 0) return null;

  async function handleDelete(supplier: string) {
    if (!confirm(`Удалить все данные поставщика «${supplier}»?\nЭто удалит прайс и все матчи (включая подтверждённые).`)) return;
    setDeleting(supplier);
    try { await deleteSupplier(supplier); onDeleted(supplier); } finally { setDeleting(null); }
  }

  return (
    <div style={{
      background: 'white', border: '1px solid #e5e7eb',
      borderRadius: '10px', marginBottom: '20px', overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '12px 16px',
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: '14px', fontWeight: 600, color: '#374151',
        }}
      >
        <span>Управление поставщиками ({suppliers.length})</span>
        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{open ? '▲ скрыть' : '▼ показать'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {suppliers.map((s) => (
            <div key={s.supplier} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 10px', background: '#f9fafb',
              border: '1px solid #e5e7eb', borderRadius: '8px',
            }}>
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{s.supplier}</span>
              <span style={{ fontSize: '12px', color: '#9ca3af' }}>{s.count} поз.</span>
              <button
                onClick={() => handleDelete(s.supplier)}
                disabled={deleting === s.supplier}
                style={{
                  padding: '2px 8px', fontSize: '12px', background: 'transparent',
                  border: '1px solid #fca5a5', borderRadius: '5px',
                  cursor: deleting === s.supplier ? 'wait' : 'pointer', color: '#dc2626',
                }}
              >
                {deleting === s.supplier ? '...' : 'Удалить'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── главная страница ─────────────────────────────────────────────────────────

type Tab = 'pending' | 'confirmed' | 'stoplist' | 'no_price' | 'awaiting' | 'auto_review';

type MatchingCache = {
  tab: Tab; items: ProductMatch[]; stats: MatchStats;
  supplierFilter: string; suppliers: { supplier: string; count: number }[]; search: string;
  autoMatchEnabled: boolean;
};
const CACHE_KEY = CACHE_KEYS.matching;

export default function MatchingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') as Tab | null;
  const cached = loadCache<MatchingCache>(CACHE_KEY);
  const [tab, setTab] = useState<Tab>(tabFromUrl ?? cached?.tab ?? 'pending');
  const [items, setItems] = useState<ProductMatch[]>(cached?.items ?? []);
  const [stats, setStats] = useState<MatchStats>(cached?.stats ?? { pending: 0, confirmed: 0, stoplist: 0, no_price: 0, auto_review: 0 });
  const [loading, setLoading] = useState(!cached);
  const [autoMatchEnabled, setAutoMatchEnabled] = useState<boolean>(cached?.autoMatchEnabled ?? true);
  const [togglingGlobal, setTogglingGlobal] = useState(false);
  const [supplierFilter, setSupplierFilter] = useState(cached?.supplierFilter ?? '');
  const [suppliers, setSuppliers] = useState<{ supplier: string; count: number }[]>(cached?.suppliers ?? []);
  const [search, setSearch] = useState(cached?.search ?? '');
  const [pendingSubTab, setPendingSubTab] = useState<'supplier_items' | 'store_skus'>('supplier_items');
  const [xlsExporting, setXlsExporting] = useState(false);
  const [xlsImporting, setXlsImporting] = useState(false);
  const [unmatchedSkuCount, setUnmatchedSkuCount] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const allStoreIds = stores.map((s) => s.id);
  const storeNamesRecord: Record<number, string> = Object.fromEntries(stores.map((s) => [s.id, s.display_name ?? s.name]));
  const [storeFilter, setStoreFilter] = useState<Set<number>>(new Set());

  async function loadSuppliers() {
    const sup = await fetchSuppliers().catch(() => []);
    setSuppliers(sup);
  }

  async function load() {
    setLoading(true);
    try {
      const [all, s, settings] = await Promise.all([
        fetchMatching(undefined, supplierFilter || undefined),
        fetchMatchingStats(supplierFilter || undefined),
        fetchSettings(),
      ]);
      setItems(all);
      setStats(s);
      setAutoMatchEnabled(settings.auto_match_enabled);
    } finally {
      setLoading(false);
    }
    loadSuppliers();
  }

  useEffect(() => {
    fetchAllStores().then((s) => {
      _storeNames = Object.fromEntries(s.map((x) => [x.id, x.display_name ?? x.name]));
      setStores(s);
      setStoreFilter(new Set(s.map((x) => x.id)));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tabFromUrl) setSearchParams({}, { replace: true }); // убираем ?tab= из URL
    if (cached && supplierFilter === (cached.supplierFilter ?? '')) return;
    load();
  }, [supplierFilter]);

  // Сохраняем состояние при каждом изменении
  useEffect(() => {
    if (!loading) {
      saveCache<MatchingCache>(CACHE_KEY, { tab, items, stats, supplierFilter, suppliers, search, autoMatchEnabled });
    }
  }, [tab, items, stats, supplierFilter, suppliers, search, loading]);

  async function handleDeleteSupplier(supplier: string) {
    setSuppliers((prev) => prev.filter((s) => s.supplier !== supplier));
    setItems((prev) => prev.filter((m) => m.supplier !== supplier));
    setStats((prev) => {
      const removed = items.filter((m) => m.supplier === supplier);
      return {
        pending: prev.pending - removed.filter((m) => m.status === 'pending').length,
        confirmed: prev.confirmed - removed.filter((m) => m.status === 'confirmed').length,
        stoplist: prev.stoplist - removed.filter((m) => m.status === 'stoplist').length,
        no_price: prev.no_price - removed.filter((m) => m.status === 'no_price').length,
        auto_review: (prev.auto_review ?? 0) - removed.filter((m) => m.status === 'auto_review').length,
      };
    });
    if (supplierFilter === supplier) setSupplierFilter('');
  }

  const storeFilteredItems = storeFilter.size === allStoreIds.length
    ? items
    : items.filter((m) => m.store_id == null || storeFilter.has(m.store_id));

  const filteredItems = search.trim()
    ? storeFilteredItems.filter((m) => {
        const q = search.trim().toLowerCase();
        return (
          m.supplier_name.toLowerCase().includes(q) ||
          (m.product_name ?? '').toLowerCase().includes(q) ||
          (m.sku ?? '').toLowerCase().includes(q)
        );
      })
    : storeFilteredItems;

  const autoReview = filteredItems.filter((m) => m.status === 'auto_review');
  const pending = filteredItems.filter((m) => m.status === 'pending');
  const confirmed = filteredItems.filter((m) => m.status === 'confirmed');
  // Дедупликация по (sku, store_id) — один SKU = одна строка
  const awaiting = (() => {
    const seen = new Set<string>();
    return filteredItems
      .filter((m) => m.status === 'awaiting_price')
      .filter((m) => {
        const key = `${m.sku ?? m.id}__${m.store_id ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();
  const stoplist = filteredItems.filter((m) => m.status === 'stoplist');
  // Дедупликация по (sku, store_id) — показываем один матч на SKU
  const noPrice = (() => {
    const seen = new Set<string>();
    return filteredItems
      .filter((m) => m.status === 'no_price')
      .filter((m) => {
        const key = `${m.sku ?? m.id}__${m.store_id ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();

  function handleConfirmed(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'confirmed' as const, match_type: 'manual' as const } : m)));
    setStats((s) => ({ ...s, pending: Math.max(0, s.pending - 1), confirmed: s.confirmed + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleStoplisted(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'stoplist' as const } : m)));
    setStats((s) => ({ ...s, pending: Math.max(0, s.pending - 1), stoplist: s.stoplist + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleNoPriceKept(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'confirmed' as const } : m)));
    setStats((s) => ({ ...s, no_price: Math.max(0, s.no_price - 1), confirmed: s.confirmed + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleNoPriceZeroed(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'awaiting_price' as const } : m)));
    setStats((s) => ({ ...s, no_price: Math.max(0, s.no_price - 1) }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleAwaitingRestored(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'no_price' as const } : m)));
    setStats((s) => ({ ...s, no_price: s.no_price + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  async function handleNoPriceZeroedAll() {
    const count = items.filter((m) => m.status === 'no_price').length;
    if (!confirm(`Обнулить остатки для ${count} товаров? Они перейдут в раздел "Ждут прайса".`)) return;
    await zeroAllNoPrice();
    setItems((prev) => prev.map((m) => m.status === 'no_price' ? { ...m, status: 'awaiting_price' as const } : m));
    setStats((s) => ({ ...s, no_price: 0 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  async function handleToggleGlobalAuto() {
    setTogglingGlobal(true);
    try {
      const res = await updateSettings({ auto_match_enabled: !autoMatchEnabled });
      setAutoMatchEnabled(res.auto_match_enabled);
    } finally {
      setTogglingGlobal(false);
    }
  }

  function handleAutoReviewApproved(id: number) {
    setItems((prev) => prev.map((m) => m.id === id ? { ...m, status: 'confirmed' as const } : m));
    setStats((s) => ({ ...s, auto_review: Math.max(0, (s.auto_review ?? 0) - 1), confirmed: s.confirmed + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleAutoReviewRejected(id: number) {
    setItems((prev) => prev.map((m) => m.id === id ? { ...m, status: 'pending' as const, sku: null, store_id: null, product_name: null, match_type: null } : m));
    setStats((s) => ({ ...s, auto_review: Math.max(0, (s.auto_review ?? 0) - 1), pending: s.pending + 1 }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  function handleReset(id: number) {
    const wasConfirmed = items.find((m) => m.id === id)?.status === 'confirmed';
    const wasStoplist = items.find((m) => m.id === id)?.status === 'stoplist';
    setItems((prev) => prev.map((m) =>
      m.id === id ? { ...m, status: 'pending' as const, sku: null, store_id: null, product_name: null, match_type: null } : m,
    ));
    setStats((s) => ({
      ...s, pending: s.pending + 1,
      confirmed: wasConfirmed ? Math.max(0, s.confirmed - 1) : s.confirmed,
      stoplist: wasStoplist ? Math.max(0, s.stoplist - 1) : s.stoplist,
    }));
    clearCache(CACHE_KEYS.uploadPrices);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 style={{ margin: 0 }}>Сопоставление товаров</h1>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или SKU…"
              style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', width: '240px' }}
            />
            <StoreFilterDropdown selected={storeFilter} onChange={setStoreFilter} allStoreIds={allStoreIds} storeNames={storeNamesRecord} />
            {suppliers.length > 0 && (
              <SupplierFilterDropdown
                value={supplierFilter}
                suppliers={suppliers}
                onChange={setSupplierFilter}
              />
            )}
            <button
              onClick={handleToggleGlobalAuto}
              disabled={togglingGlobal}
              title={autoMatchEnabled ? 'Авто-матчинг включён — нажми чтобы отключить' : 'Авто-матчинг выключен — нажми чтобы включить'}
              style={{
                padding: '8px 14px', fontSize: '14px', borderRadius: '8px',
                border: '1px solid #d1d5db',
                background: autoMatchEnabled ? '#fff' : '#f3f4f6',
                color: '#374151',
                cursor: togglingGlobal ? 'wait' : 'pointer',
              }}
            >
              Авто-матчинг: {autoMatchEnabled ? 'вкл' : 'выкл'}
            </button>
            <button
              onClick={load}
              style={{ padding: '8px 14px', fontSize: '14px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '8px', cursor: 'pointer', color: '#374151' }}
            >
              Обновить
            </button>
          </div>
        </div>
      </div>

      <SuppliersPanel suppliers={suppliers} onDeleted={handleDeleteSupplier} />

      {stats.no_price > 0 && (
        <div
          onClick={() => setTab('no_price')}
          style={{
            background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: '10px',
            padding: '12px 16px', marginBottom: '16px', fontSize: '14px', color: '#92400e',
            display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
          }}
        >
          <span>⚠</span>
          <span><strong>{stats.no_price}</strong> товаров пропали из прайса поставщика — требуют решения.</span>
          <span style={{ marginLeft: 'auto', fontSize: '12px', textDecoration: 'underline' }}>Посмотреть →</span>
        </div>
      )}

      {stats.pending > 0 && (
        <div style={{
          background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '10px',
          padding: '12px 16px', marginBottom: '20px', fontSize: '14px', color: '#92400e',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <span>⚠</span>
          <span><strong>{stats.pending}</strong> позиций ожидают сопоставления. Расчёт цен недоступен до проверки всех совпадений.</span>
        </div>
      )}

      {(stats.auto_review ?? 0) > 0 && (
        <div
          onClick={() => setTab('auto_review')}
          style={{
            background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: '10px',
            padding: '12px 16px', marginBottom: '16px', fontSize: '14px', color: '#92400e',
            display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
          }}
        >
          <span>🔍</span>
          <span><strong>{stats.auto_review}</strong> авто-предложений ждут проверки.</span>
          <span style={{ marginLeft: 'auto', fontSize: '12px', textDecoration: 'underline' }}>Посмотреть →</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', alignItems: 'center' }}>
        <TabBtn label="Ожидают" count={pending.length} active={tab === 'pending'} warn onClick={() => setTab('pending')} />
        <TabBtn label="На проверке" count={autoReview.length} active={tab === 'auto_review'} warn={autoReview.length > 0} onClick={() => setTab('auto_review')} />
        <TabBtn label="Сопоставлено" count={confirmed.length} active={tab === 'confirmed'} onClick={() => setTab('confirmed')} />
        <TabBtn label="Ждут прайса" count={awaiting.length} active={tab === 'awaiting'} onClick={() => setTab('awaiting')} />
        <TabBtn label="Стоп-лист" count={stoplist.length} active={tab === 'stoplist'} onClick={() => setTab('stoplist')} />
        <TabBtn label="Пропали из прайса" count={noPrice.length} active={tab === 'no_price'} warn onClick={() => setTab('no_price')} />
      </div>

      {loading ? (
        <LoadingCats />
      ) : (() => {
        const TAB_NAMES: Record<string, string> = {
          pending: 'ожидают', auto_review: 'на_проверке', confirmed: 'сопоставлено',
          awaiting: 'ждут_прайса', stoplist: 'стоп_лист', no_price: 'пропали_из_прайса',
        };
        const currentItems = tab === 'pending' ? pending : tab === 'auto_review' ? autoReview
          : tab === 'confirmed' ? confirmed : tab === 'awaiting' ? awaiting
          : tab === 'stoplist' ? stoplist : noPrice;
        return (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', marginBottom: '4px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
              {tab === 'pending' && (
                <>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = '';
                      setXlsImporting(true);
                      try {
                        const fn = pendingSubTab === 'supplier_items' ? importSupplierMatches : importSkuMatches;
                        const res = await fn(file);
                        alert(`Импортировано: ${res.updated}${res.errors.length ? '\nОшибки:\n' + res.errors.join('\n') : ''}`);
                        await load();
                      } catch (err: any) {
                        alert(`Ошибка: ${err.message}`);
                      } finally {
                        setXlsImporting(false);
                      }
                    }}
                  />
                  <button
                    disabled={xlsImporting}
                    onClick={() => importInputRef.current?.click()}
                    style={{
                      padding: '3px 10px', fontSize: '12px', background: '#fff',
                      border: '1px solid #e5e7eb', borderRadius: '6px',
                      cursor: xlsImporting ? 'default' : 'pointer',
                      color: xlsImporting ? '#9ca3af' : '#6b7280', opacity: xlsImporting ? 0.7 : 1,
                    }}
                  >
                    {xlsImporting ? 'Загрузка...' : '↑ XLS'}
                  </button>
                </>
              )}
              <button
                disabled={xlsExporting}
                onClick={async () => {
                  try {
                    if (tab === 'pending' && pendingSubTab === 'supplier_items') {
                      setXlsExporting(true);
                      const data = await fetchExportPending();
                      const rows = data.map((item) => {
                        const row: Record<string, unknown> = {
                          'Поставщик': item.supplier,
                          'Название (поставщик)': item.supplier_name,
                          'Цена закупки': item.supplier_price ?? '',
                        };
                        item.candidates.forEach((c, i) => {
                          row[`К${i + 1}: SKU`] = c.sku;
                          row[`К${i + 1}: Магазин`] = storeNames(c.store_id);
                          row[`К${i + 1}: Название`] = c.product_name;
                          row[`К${i + 1}: Совпадение`] = `${Math.round(c.score * 100)}%`;
                        });
                        row['Выбор (1-6)'] = '';
                        return row;
                      });
                      exportToXls(rows, 'незамэтченные_поставщики');
                    } else if (tab === 'pending' && pendingSubTab === 'store_skus') {
                      setXlsExporting(true);
                      const data = await fetchExportUnmatchedSkus();
                      const rows = data.map((item) => {
                        const row: Record<string, unknown> = {
                          'Магазин': item.store,
                          'SKU': item.sku,
                          'Название': item.name ?? '',
                          'Цена': item.price ?? '',
                        };
                        item.candidates.forEach((c, i) => {
                          row[`К${i + 1}: Поставщик`] = c.supplier;
                          row[`К${i + 1}: Название`] = c.supplier_name;
                          row[`К${i + 1}: Цена закупки`] = c.supplier_price ?? '';
                          row[`К${i + 1}: Совпадение`] = `${Math.round(c.score * 100)}%`;
                        });
                        row['Выбор (1-6)'] = '';
                        return row;
                      });
                      exportToXls(rows, 'незамэтченные_sku');
                    } else {
                      exportToXls(currentItems.map((m) => ({
                        'Товар поставщика': m.supplier_name,
                        'Поставщик': m.supplier,
                        'Цена закупки': m.supplier_price ?? '',
                        'Магазин': storeNames(m.store_id ?? 0),
                        'SKU': m.sku ?? '',
                        'Товар в магазине': m.product_name ?? '',
                        'Статус': m.status,
                        'Тип матча': m.match_type ?? '',
                        'Сходство': m.best_score != null ? `${Math.round(m.best_score * 100)}%` : '',
                      })), `матчинг_${TAB_NAMES[tab] ?? tab}`);
                    }
                  } catch (e: any) {
                    alert(`Ошибка экспорта: ${e.message}`);
                  } finally {
                    setXlsExporting(false);
                  }
                }}
                style={{
                  padding: '3px 10px', fontSize: '12px', background: '#fff',
                  border: '1px solid #e5e7eb', borderRadius: '6px', cursor: xlsExporting ? 'default' : 'pointer',
                  color: xlsExporting ? '#9ca3af' : '#6b7280', opacity: xlsExporting ? 0.7 : 1,
                }}
              >
                {xlsExporting ? 'Формируется...' : '↓ XLS'}
              </button>
              </div>
              {xlsExporting && tab === 'pending' && (
                <div className="progress-bar" style={{ width: '120px' }}>
                  <div className="progress-bar__fill progress-bar__fill--processing" />
                </div>
              )}
            </div>
            {tab === 'pending' && (
              <>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setPendingSubTab('supplier_items')}
                    style={{
                      padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
                      background: pendingSubTab === 'supplier_items' ? '#374151' : 'transparent',
                      color: pendingSubTab === 'supplier_items' ? 'white' : '#6b7280',
                      border: '1px solid', borderColor: pendingSubTab === 'supplier_items' ? '#374151' : '#e5e7eb',
                      cursor: 'pointer', fontWeight: pendingSubTab === 'supplier_items' ? 600 : 400,
                    }}
                  >
                    Товары поставщика
                    <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>{pending.length}</span>
                  </button>
                  <button
                    onClick={() => setPendingSubTab('store_skus')}
                    style={{
                      padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
                      background: pendingSubTab === 'store_skus' ? '#374151' : 'transparent',
                      color: pendingSubTab === 'store_skus' ? 'white' : '#6b7280',
                      border: '1px solid', borderColor: pendingSubTab === 'store_skus' ? '#374151' : '#e5e7eb',
                      cursor: 'pointer', fontWeight: pendingSubTab === 'store_skus' ? 600 : 400,
                    }}
                  >
                    SKU магазинов
                    {unmatchedSkuCount !== null && (
                      <span style={{ marginLeft: '6px', fontSize: '12px', opacity: 0.8 }}>{unmatchedSkuCount}</span>
                    )}
                  </button>
                </div>
                {pendingSubTab === 'supplier_items'
                  ? <PendingTab items={pending} onConfirmed={(id) => handleConfirmed(id)} onStoplisted={handleStoplisted} />
                  : <StoreSkusTab onMatchConfirmed={() => { clearCache(CACHE_KEYS.uploadPrices); setStats((s) => ({ ...s, confirmed: s.confirmed + 1 })); }} onCountLoaded={setUnmatchedSkuCount} />
                }
              </>
            )}
            {tab === 'auto_review' && <AutoReviewTab items={autoReview} onApproved={handleAutoReviewApproved} onRejected={handleAutoReviewRejected} />}
            {tab === 'confirmed' && <ConfirmedTab items={confirmed} onReset={handleReset} />}
            {tab === 'awaiting' && <AwaitingTab items={awaiting} onRestored={handleAwaitingRestored} />}
            {tab === 'stoplist' && <StoplistTab items={stoplist} onRestored={handleReset} />}
            {tab === 'no_price' && <NoPriceTab items={noPrice} onKept={handleNoPriceKept} onZeroed={handleNoPriceZeroed} onZeroedAll={handleNoPriceZeroedAll} />}
          </>
        );
      })()}
    </div>
  );
}
