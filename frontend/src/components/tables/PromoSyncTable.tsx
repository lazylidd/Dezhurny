import { useState } from 'react';
import type { PromoSyncEntry } from '../../api/prices';

// ─── конфиг действий ──────────────────────────────────────────────────────────

const ACTION_CFG: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  ADDED:         { label: 'Добавлен в акцию',   color: '#166534', bg: '#dcfce7', dot: '#16a34a' },
  PRICE_UPDATED: { label: 'Цена обновлена',      color: '#1e40af', bg: '#dbeafe', dot: '#2563eb' },
  REMOVED:       { label: 'Выведен из акции',    color: '#991b1b', bg: '#fee2e2', dot: '#dc2626' },
  SKIPPED:       { label: 'Пропущен',            color: '#6b7280', bg: '#f3f4f6', dot: '#9ca3af' },
};

// ─── фильтр по действию ───────────────────────────────────────────────────────

type ActionFilter = 'ALL' | 'ADDED' | 'PRICE_UPDATED' | 'REMOVED' | 'SKIPPED';

// ─── форматирование ───────────────────────────────────────────────────────────

function fmt(v: number | null) {
  if (v == null) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₽';
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── компонент ────────────────────────────────────────────────────────────────

export default function PromoSyncTable({ items }: { items: PromoSyncEntry[] }) {
  const [actionFilter, setActionFilter] = useState<ActionFilter>('ALL');

  if (items.length === 0) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>
        Нет данных. Лог заполняется после применения цен при включённой синхронизации с акциями.
      </div>
    );
  }

  // Статистика по действиям
  const counts: Record<string, number> = {};
  for (const row of items) {
    counts[row.action] = (counts[row.action] ?? 0) + 1;
  }

  // Статистика по акциям: promo_id → { name, counts по action }
  const promoStats: Record<string, { name: string; counts: Record<string, number> }> = {};
  for (const row of items) {
    if (!promoStats[row.promo_id]) {
      promoStats[row.promo_id] = { name: row.promo_name ?? row.promo_id, counts: {} };
    }
    const ps = promoStats[row.promo_id].counts;
    ps[row.action] = (ps[row.action] ?? 0) + 1;
  }

  const filtered = actionFilter === 'ALL' ? items : items.filter(r => r.action === actionFilter);

  return (
    <div>
      {/* ── статистика по акциям ── */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {Object.entries(promoStats).map(([promoId, { name, counts: pc }]) => (
          <div key={promoId} style={{
            border: '1px solid #e5e7eb', borderRadius: '10px',
            padding: '10px 14px', background: 'white', minWidth: '200px',
          }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#111827', marginBottom: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px' }} title={name}>
              {name}
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['REMOVED', 'PRICE_UPDATED', 'ADDED', 'SKIPPED'] as const).map(action => {
                const n = pc[action] ?? 0;
                if (n === 0) return null;
                const cfg = ACTION_CFG[action];
                return (
                  <span key={action} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                    padding: '2px 7px', borderRadius: '10px', fontSize: '11px', fontWeight: 500,
                    color: cfg.color, background: cfg.bg,
                  }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: cfg.dot }} />
                    {n}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── фильтры по действию ── */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {/* кнопка "Все" */}
        <button
          onClick={() => setActionFilter('ALL')}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 14px', borderRadius: '10px', border: '2px solid',
            borderColor: actionFilter === 'ALL' ? '#6b7280' : '#e5e7eb',
            background: actionFilter === 'ALL' ? '#f3f4f6' : 'white',
            cursor: 'pointer', fontSize: '13px', fontWeight: 500, color: '#374151',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ fontWeight: 600 }}>Все</span>
          <span style={{
            padding: '1px 8px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
            background: '#e5e7eb', color: '#374151',
          }}>
            {items.length}
          </span>
        </button>

        {(['REMOVED', 'PRICE_UPDATED', 'ADDED', 'SKIPPED'] as ActionFilter[]).map(action => {
          const cfg = ACTION_CFG[action];
          const count = counts[action] ?? 0;
          const active = actionFilter === action;
          return (
            <button
              key={action}
              onClick={() => setActionFilter(active ? 'ALL' : action)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 14px', borderRadius: '10px', border: '2px solid',
                borderColor: active ? cfg.dot : '#e5e7eb',
                background: active ? cfg.bg : 'white',
                cursor: 'pointer', fontSize: '13px', fontWeight: 500,
                color: active ? cfg.color : '#374151',
                transition: 'all 0.15s', opacity: count === 0 ? 0.4 : 1,
              }}
            >
              <span style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: cfg.dot, flexShrink: 0,
              }} />
              <span>{cfg.label}</span>
              <span style={{
                padding: '1px 8px', borderRadius: '10px', fontSize: '12px', fontWeight: 600,
                background: active ? 'rgba(255,255,255,0.7)' : cfg.bg,
                color: cfg.color,
              }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── таблица ── */}
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th className="th" style={{ width: 100 }}>Время</th>
              <th className="th" style={{ width: 220 }}>SKU</th>
              <th className="th" style={{ width: 200 }}>Акция</th>
              <th className="th" style={{ width: 140 }}>Действие</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Каталог до</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Каталог после</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Акц. цена до</th>
              <th className="th" style={{ width: 110, textAlign: 'right' }}>Акц. цена после</th>
              <th className="th">Причина</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '13px' }}>
                  Нет записей
                </td>
              </tr>
            ) : (
              filtered.map(row => {
                const cfg = ACTION_CFG[row.action] ?? ACTION_CFG.SKIPPED;
                return (
                  <tr key={row.id} className="tr">
                    <td className="td" style={{ color: '#9ca3af', whiteSpace: 'nowrap', fontSize: '12px' }}>
                      {fmtTime(row.timestamp)}
                    </td>
                    <td className="td" style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {row.sku}
                    </td>
                    <td className="td" style={{ fontSize: '12px', color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.promo_id}>
                      {row.promo_name ?? row.promo_id}
                    </td>
                    <td className="td">
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500,
                        color: cfg.color, background: cfg.bg,
                      }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: cfg.dot, flexShrink: 0 }} />
                        {cfg.label}
                      </span>
                    </td>
                    <td className="td" style={{ textAlign: 'right', color: '#6b7280', fontSize: '13px' }}>
                      {fmt(row.old_catalog_price)}
                    </td>
                    <td className="td" style={{ textAlign: 'right', fontWeight: 500, fontSize: '13px' }}>
                      {fmt(row.new_catalog_price)}
                    </td>
                    <td className="td" style={{ textAlign: 'right', color: '#6b7280', fontSize: '13px' }}>
                      {fmt(row.old_promo_price)}
                    </td>
                    <td className="td" style={{ textAlign: 'right', fontWeight: 500, fontSize: '13px' }}>
                      {fmt(row.new_promo_price)}
                    </td>
                    <td className="td" style={{ fontSize: '12px', color: '#9ca3af', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.reason ?? ''}>
                      {row.reason ?? '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
