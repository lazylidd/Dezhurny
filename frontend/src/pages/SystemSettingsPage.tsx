import { useEffect, useState } from 'react';
import { changePassword, checkMe, logout } from '../api/auth';
import { fetchSettings, saveSettings, type AppSettings } from '../api/settings';
import { createStore, deleteStore, fetchAllStores, updateStore, updateStoreCredentials } from '../api/stores';
import type { Store } from '../types/store';

// ─── Anti-affiliation settings ────────────────────────────────────────────────

type AffFormValues = {
  sync_interval_min: string;
  sync_interval_max: string;
  sync_inter_store_delay_min: string;
  sync_inter_store_delay_max: string;
  sync_start_jitter_max: string;
  price_stock_jitter_min: string;
  price_stock_jitter_max: string;
  apply_inter_store_delay_min: string;
  apply_inter_store_delay_max: string;
};

function toAffForm(s: AppSettings): AffFormValues {
  return {
    sync_interval_min: String(Math.round(s.sync_interval_min / 60)),
    sync_interval_max: String(Math.round(s.sync_interval_max / 60)),
    sync_inter_store_delay_min: String(Math.round(s.sync_inter_store_delay_min / 60)),
    sync_inter_store_delay_max: String(Math.round(s.sync_inter_store_delay_max / 60)),
    sync_start_jitter_max: String(s.sync_start_jitter_max),
    price_stock_jitter_min: String(s.price_stock_jitter_min),
    price_stock_jitter_max: String(s.price_stock_jitter_max),
    apply_inter_store_delay_min: String(Math.round(s.apply_inter_store_delay_min / 60)),
    apply_inter_store_delay_max: String(Math.round(s.apply_inter_store_delay_max / 60)),
  };
}

function toAffPayload(f: AffFormValues): Partial<AppSettings> {
  return {
    sync_interval_min: Number(f.sync_interval_min) * 60,
    sync_interval_max: Number(f.sync_interval_max) * 60,
    sync_inter_store_delay_min: Number(f.sync_inter_store_delay_min) * 60,
    sync_inter_store_delay_max: Number(f.sync_inter_store_delay_max) * 60,
    sync_start_jitter_max: Number(f.sync_start_jitter_max),
    price_stock_jitter_min: Number(f.price_stock_jitter_min),
    price_stock_jitter_max: Number(f.price_stock_jitter_max),
    apply_inter_store_delay_min: Number(f.apply_inter_store_delay_min) * 60,
    apply_inter_store_delay_max: Number(f.apply_inter_store_delay_max) * 60,
  };
}

const inputStyle: React.CSSProperties = {
  padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '14px', width: '90px',
};
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle: React.CSSProperties = { fontSize: '12px', color: '#6b7280' };

function NumField({ label, value, onChange, unit }: {
  label: string; value: string; onChange: (v: string) => void; unit: string;
}) {
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <input style={inputStyle} type="number" min="0" step="1" value={value}
          onChange={(e) => onChange(e.target.value)} />
        <span style={{ fontSize: '13px', color: '#9ca3af' }}>{unit}</span>
      </div>
    </div>
  );
}

// ─── Store form (add/edit) ─────────────────────────────────────────────────────

type StoreFormData = {
  display_name: string;
  name: string;
  api_key: string;
  business_id: string;
  campaign_ids: string;
};

function StoreForm({
  initial, onSave, onCancel, title,
}: {
  initial?: Partial<StoreFormData>;
  onSave: (d: StoreFormData) => Promise<void>;
  onCancel: () => void;
  title: string;
}) {
  const [form, setForm] = useState<StoreFormData>({
    display_name: initial?.display_name ?? '',
    name: initial?.name ?? '',
    api_key: initial?.api_key ?? '',
    business_id: initial?.business_id ?? '',
    campaign_ids: initial?.campaign_ids ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const wideInput: React.CSSProperties = {
    padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px',
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.display_name.trim()) { setError('Укажите название магазина'); return; }
    if (!form.name.trim()) { setError('Укажите внутренний идентификатор (slug)'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: '16px' }}>
      <div style={{ fontWeight: 600, marginBottom: '16px' }}>{title}</div>
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
          <div style={fieldStyle}>
            <span style={labelStyle}>Название (отображаемое) *</span>
            <input style={wideInput} value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              placeholder="Яндекс Маркет 16" />
          </div>
          <div style={fieldStyle}>
            <span style={labelStyle}>Внутренний ID (slug) *</span>
            <input style={wideInput} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="yam16" />
          </div>
          <div style={fieldStyle}>
            <span style={labelStyle}>API ключ</span>
            <input style={wideInput} type="password" value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="ACMA:..." />
          </div>
          <div style={fieldStyle}>
            <span style={labelStyle}>Business ID</span>
            <input style={wideInput} value={form.business_id}
              onChange={(e) => setForm({ ...form, business_id: e.target.value })}
              placeholder="123456" />
          </div>
          <div style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
            <span style={labelStyle}>Campaign IDs (через запятую)</span>
            <input style={wideInput} value={form.campaign_ids}
              onChange={(e) => setForm({ ...form, campaign_ids: e.target.value })}
              placeholder="111,222,333" />
          </div>
        </div>
        {error && <div style={{ color: 'red', fontSize: '13px', marginBottom: '8px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="button" type="submit" disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <button type="button" onClick={onCancel}
            style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', background: '#fff', fontSize: '14px' }}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Store row ─────────────────────────────────────────────────────────────────

type StoreWithCredentials = Store & { api_key?: string | null; business_id?: string | null; campaign_ids?: string | null };

function StoreRow({ store, onUpdated, onDeleted }: {
  store: StoreWithCredentials;
  onUpdated: (s: Store) => void;
  onDeleted: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(d: StoreFormData) {
    const updated = await updateStoreCredentials(store.id, d);
    onUpdated(updated);
    setEditing(false);
  }

  async function handleDelete() {
    if (!window.confirm(`Удалить магазин «${store.display_name ?? store.name}»? Это удалит все товары и обновления цен для него.`)) return;
    setDeleting(true);
    try {
      await deleteStore(store.id);
      onDeleted(store.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  if (editing) {
    return (
      <StoreForm
        title={`Редактировать: ${store.display_name ?? store.name}`}
        initial={{
          display_name: store.display_name ?? '',
          name: store.name,
          api_key: store.api_key ?? '',
          business_id: store.business_id ?? '',
          campaign_ids: store.campaign_ids ?? '',
        }}
        onSave={handleSave}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '8px',
    }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>{store.display_name ?? store.name}</div>
        <div style={{ fontSize: '12px', color: '#9ca3af' }}>slug: {store.name} · {store.platform ?? 'Яндекс Маркет'}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setEditing(true)}
            style={{ padding: '6px 12px', fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', background: '#fff' }}>
            Редактировать
          </button>
          <button onClick={handleDelete} disabled={deleting}
            style={{ padding: '6px 12px', fontSize: '13px', border: '1px solid #fca5a5', borderRadius: '6px', cursor: 'pointer', background: '#fff', color: '#dc2626' }}>
            {deleting ? '...' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function SystemSettingsPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [stores, setStores] = useState<StoreWithCredentials[]>([]);
  const [addingStore, setAddingStore] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoDetailsOpen, setPromoDetailsOpen] = useState(false);
  const [promoSyncing, setPromoSyncing] = useState<number | null>(null);
  const [affOpen, setAffOpen] = useState(false);
  const [affForm, setAffForm] = useState<AffFormValues | null>(null);
  const [affSaving, setAffSaving] = useState(false);
  const [affSaved, setAffSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  // Смена пароля
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);

  useEffect(() => {
    checkMe().then((me) => {
      setIsAdmin(me.is_admin);
    }).catch(() => {});

    fetchAllStores().then(setStores).catch((e) => setError(e.message));
  }, []);

  // Load aff settings when isAdmin becomes true
  useEffect(() => {
    if (isAdmin && !affForm) {
      fetchSettings().then((s) => setAffForm(toAffForm(s))).catch(() => {});
    }
  }, [isAdmin]);

  function setAff(key: keyof AffFormValues, value: string) {
    setAffForm((prev) => prev ? { ...prev, [key]: value } : prev);
    setAffSaved(false);
  }

  async function handleSaveAff() {
    if (!affForm) return;
    setAffSaving(true);
    try {
      const updated = await saveSettings(toAffPayload(affForm));
      setAffForm(toAffForm(updated));
      setAffSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAffSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwSuccess(false);
    if (pwNew !== pwConfirm) { setPwError('Новые пароли не совпадают'); return; }
    if (pwNew.length < 6) { setPwError('Пароль должен быть не менее 6 символов'); return; }
    setPwSaving(true);
    try {
      await changePassword(pwCurrent, pwNew);
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      setPwSuccess(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwSaving(false);
    }
  }

  async function handlePromoToggle(storeId: number, val: boolean) {
    setPromoSyncing(storeId);
    try {
      const updated = await updateStore(String(storeId), { auto_promo_sync: val });
      setStores((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setPromoSyncing(null);
    }
  }

  async function handleAddStore(d: StoreFormData) {
    const newStore = await createStore(d);
    setStores((prev) => [...prev, newStore as StoreWithCredentials]);
    setAddingStore(false);
  }

  return (
    <div>
      <h1 style={{ marginBottom: '24px' }}>Системные настройки</h1>

      {error && <div style={{ color: 'red', marginBottom: '16px' }}>{error}</div>}

      {/* Магазины */}
      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ fontWeight: 700 }}>Магазины</div>
          {!addingStore && (
            <button className="button" onClick={() => setAddingStore(true)}>
              + Добавить магазин
            </button>
          )}
        </div>

        {addingStore && (
          <StoreForm
            title="Новый магазин"
            onSave={handleAddStore}
            onCancel={() => setAddingStore(false)}
          />
        )}

        {stores.length === 0 && !addingStore && (
          <div style={{ color: '#9ca3af', fontSize: '14px' }}>Нет магазинов</div>
        )}

        {stores.map((s) => (
          <StoreRow
            key={s.id}
            store={s}
            onUpdated={(updated) => setStores((prev) => prev.map((x) => x.id === updated.id ? { ...x, ...updated } : x))}
            onDeleted={(id) => setStores((prev) => prev.filter((x) => x.id !== id))}
          />
        ))}
      </div>

      {/* Автосинхронизация с акциями */}
      <div className="card" style={{ marginBottom: '24px' }}>
        <button
          onClick={() => setPromoOpen((v) => !v)}
          style={{
            width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '15px' }}>Автосинхронизация с акциями</div>
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>{promoOpen ? '▲ свернуть' : '▼ развернуть'}</span>
        </button>

        {promoOpen && (
          <div style={{ marginTop: '16px' }}>
            <div style={{
              background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px',
              padding: '12px 16px', marginBottom: '20px', fontSize: '13px', color: '#92400e', lineHeight: '1.5',
            }}>
              <strong>Зачем это нужно?</strong><br />
              После каждого применения цен система проверяет участие ваших товаров в акциях Яндекс Маркета.
              Если акционная цена оказалась ниже каталожной — она автоматически поднимается до каталожной.
              Если ЯМ не принимает обновление — товар удаляется из акции.
              Это защищает от ситуации, когда вы торгуете себе в убыток из-за акций, в которые попали без вашего ведома.{' '}
              <button
                onClick={() => setPromoDetailsOpen((v) => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400e', fontSize: '13px', padding: 0, textDecoration: 'underline' }}
              >
                {promoDetailsOpen ? 'Скрыть подробности' : 'Подробнее о сценариях →'}
              </button>

              {promoDetailsOpen && (
                <div style={{ marginTop: '12px', borderTop: '1px solid #fde68a', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>
                    <strong>🟡 Товар в акции, акционная цена ≤ каталожной</strong><br />
                    Система поднимает акционную цену до каталожной. Если ЯМ отклоняет обновление (цена вне допустимого диапазона акции или истёк срок) — товар удаляется из акции. Действие: <em>PRICE_UPDATED</em> или <em>REMOVED</em>.
                  </div>
                  <div>
                    <strong>🟢 Товар в акции, акционная цена {'>'} каталожной</strong><br />
                    Цена и так нас устраивает — акционная выше нашей каталожной, значит мы зарабатываем больше. Не трогаем. Действие: <em>SKIPPED (promo_price_ok)</em>.
                  </div>
                  <div>
                    <strong>⚪ Товар не в акции</strong><br />
                    Не трогаем. API ЯМ не позволяет надёжно проверить eligible-статус, поэтому автодобавление отключено — управляем только теми, кто уже участвует.
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '12px', color: '#a16207' }}>
                    Все действия записываются в лог — его можно посмотреть на странице обновления цен во вкладке «Акции».
                  </div>
                </div>
              )}
            </div>
            {stores.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: '14px' }}>Нет магазинов</div>
            ) : (
              stores.map((s) => (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 0', borderBottom: '1px solid #f3f4f6',
                }}>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: '14px' }}>{s.display_name ?? s.name}</div>
                    <div style={{ fontSize: '12px', color: '#9ca3af' }}>{s.name}</div>
                  </div>
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    cursor: promoSyncing === s.id ? 'wait' : 'pointer', fontSize: '13px', color: '#374151',
                  }}>
                    <input
                      type="checkbox"
                      checked={s.auto_promo_sync ?? false}
                      disabled={promoSyncing === s.id}
                      onChange={(e) => handlePromoToggle(s.id, e.target.checked)}
                      style={{ width: '15px', height: '15px', accentColor: '#374151' }}
                    />
                    {promoSyncing === s.id ? 'Сохранение...' : 'Включить'}
                  </label>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Анти-аффилированность (admin only, collapsible) */}
      {isAdmin && (
        <div className="card" style={{ marginBottom: '24px' }}>
          <button
            onClick={() => setAffOpen((v) => !v)}
            style={{
              width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '15px' }}>Анти-аффилированность</div>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>{affOpen ? '▲ свернуть' : '▼ развернуть'}</span>
          </button>

          {affOpen && (
            <div style={{ marginTop: '16px' }}>
              <div style={{
                background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px',
                padding: '12px 16px', marginBottom: '20px', fontSize: '13px', color: '#92400e', lineHeight: '1.5',
              }}>
                <strong>Зачем это нужно?</strong><br />
                Случайные задержки между действиями разных магазинов скрывают их аффилированность.
                Это снижает риск блокировки за «дробление бизнеса» со стороны Яндекс Маркета,
                а также защищает остальные кабинеты при блокировке одного из них —
                паттерны активности не будут идентичными.
              </div>

              {affForm && (
                <>
                  <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '12px', color: '#374151' }}>
                    Авто-синхронизация ассортимента
                  </div>
                  <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
                    <NumField label="Интервал — мин." value={affForm.sync_interval_min}
                      onChange={(v) => setAff('sync_interval_min', v)} unit="мин" />
                    <NumField label="Интервал — макс." value={affForm.sync_interval_max}
                      onChange={(v) => setAff('sync_interval_max', v)} unit="мин" />
                    <NumField label="Пауза между магазинами — мин." value={affForm.sync_inter_store_delay_min}
                      onChange={(v) => setAff('sync_inter_store_delay_min', v)} unit="мин" />
                    <NumField label="Пауза между магазинами — макс." value={affForm.sync_inter_store_delay_max}
                      onChange={(v) => setAff('sync_inter_store_delay_max', v)} unit="мин" />
                    <NumField label="Jitter перед стартом — макс." value={affForm.sync_start_jitter_max}
                      onChange={(v) => setAff('sync_start_jitter_max', v)} unit="сек" />
                  </div>

                  <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '12px', color: '#374151' }}>
                    Применение цен
                  </div>
                  <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
                    <NumField label="Jitter цена→остаток — мин." value={affForm.price_stock_jitter_min}
                      onChange={(v) => setAff('price_stock_jitter_min', v)} unit="сек" />
                    <NumField label="Jitter цена→остаток — макс." value={affForm.price_stock_jitter_max}
                      onChange={(v) => setAff('price_stock_jitter_max', v)} unit="сек" />
                    <NumField label="Пауза между магазинами — мин." value={affForm.apply_inter_store_delay_min}
                      onChange={(v) => setAff('apply_inter_store_delay_min', v)} unit="мин" />
                    <NumField label="Пауза между магазинами — макс." value={affForm.apply_inter_store_delay_max}
                      onChange={(v) => setAff('apply_inter_store_delay_max', v)} unit="мин" />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button className="button" onClick={handleSaveAff} disabled={affSaving}>
                      {affSaving ? 'Сохранение...' : 'Сохранить'}
                    </button>
                    {affSaved && <span style={{ color: '#16a34a', fontSize: '14px' }}>Сохранено</span>}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Смена пароля */}
      <div className="card" style={{ marginBottom: '24px' }}>
        <button
          onClick={() => setPwOpen((v) => !v)}
          style={{
            width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '15px' }}>Смена пароля</div>
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>{pwOpen ? '▲ свернуть' : '▼ развернуть'}</span>
        </button>
        {pwOpen && (
          <form onSubmit={handleChangePassword} style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '360px' }}>
              <div style={fieldStyle}>
                <span style={labelStyle}>Текущий пароль</span>
                <input
                  type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' }}
                  required
                />
              </div>
              <div style={fieldStyle}>
                <span style={labelStyle}>Новый пароль</span>
                <input
                  type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' }}
                  required
                />
              </div>
              <div style={fieldStyle}>
                <span style={labelStyle}>Повторите новый пароль</span>
                <input
                  type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)}
                  style={{ padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px' }}
                  required
                />
              </div>
              {pwError && <div style={{ color: '#dc2626', fontSize: '13px' }}>{pwError}</div>}
              {pwSuccess && <div style={{ color: '#16a34a', fontSize: '13px' }}>Пароль успешно изменён</div>}
              <div>
                <button className="button" type="submit" disabled={pwSaving}>
                  {pwSaving ? 'Сохранение...' : 'Сменить пароль'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Выход из аккаунта */}
      <div className="card" style={{ marginTop: '24px' }}>
        <div style={{ fontWeight: 700, marginBottom: '12px' }}>Аккаунт</div>
        <button
          onClick={async () => {
            await logout();
            window.location.href = '/login';
          }}
          style={{
            padding: '8px 20px', fontSize: '14px', borderRadius: '6px', cursor: 'pointer',
            background: '#fff', border: '1px solid #fca5a5', color: '#dc2626',
          }}
        >
          Выйти из аккаунта
        </button>
      </div>
    </div>
  );
}
