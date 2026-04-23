import { useEffect, useState } from 'react';
import LoadingCats from '../components/ui/LoadingCats';
import { fetchAllStores } from '../api/stores';
import {
  addUserStore, createStore, createUser, deleteUser,
  fetchAdminUsers, removeUserStore, updateUser,
  type AdminUser,
} from '../api/admin';
import type { Store } from '../types/store';

interface UserFormData {
  login: string;
  display_name: string;
  comment: string;
  payment_due_date: string;
  is_admin: boolean;
  password?: string;
}

const inputStyle = {
  padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', width: '100%', boxSizing: 'border-box' as const,
};
const labelStyle = { fontSize: '12px', color: '#6b7280', marginBottom: '4px', display: 'block' };

// ─── UserForm ────────────────────────────────────────────────────────────────

interface UserFormProps {
  initial?: Partial<AdminUser>;
  onSave: (data: UserFormData) => Promise<void>;
  onCancel: () => void;
  title: string;
}

function UserForm({ initial, onSave, onCancel, title }: UserFormProps) {
  const [login, setLogin] = useState(initial?.login ?? '');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [paymentDue, setPaymentDue] = useState(initial?.payment_due_date ?? '');
  const [isAdmin, setIsAdmin] = useState(initial?.is_admin ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload: UserFormData = { login, display_name: displayName, comment, payment_due_date: paymentDue, is_admin: isAdmin };
      if (password) payload.password = password;
      await onSave(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 440, maxHeight: '90vh', overflow: 'auto', padding: '24px' }}>
        <h3 style={{ margin: '0 0 20px', fontSize: '16px' }}>{title}</h3>
        {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '13px' }}>{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={labelStyle}>Отображаемое имя *</label>
            <input style={inputStyle} value={displayName} onChange={e => setDisplayName(e.target.value)} required />
          </div>
          <div>
            <label style={labelStyle}>Логин *</label>
            <input style={inputStyle} value={login} onChange={e => setLogin(e.target.value)} required autoComplete="off" />
          </div>
          <div>
            <label style={labelStyle}>{initial ? 'Новый пароль (оставьте пустым чтобы не менять)' : 'Пароль *'}</label>
            <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} required={!initial} autoComplete="new-password" />
          </div>
          <div>
            <label style={labelStyle}>Комментарий</label>
            <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: '60px' }} value={comment} onChange={e => setComment(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Дата следующей оплаты</label>
            <input style={inputStyle} type="date" value={paymentDue} onChange={e => setPaymentDue(e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input type="checkbox" id="isAdmin" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} />
            <label htmlFor="isAdmin" style={{ fontSize: '13px', cursor: 'pointer' }}>Права администратора</label>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
            <button type="button" onClick={onCancel} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', background: 'white', color: '#374151' }}>
              Отмена
            </button>
            <button type="submit" disabled={saving} className="button" style={{ whiteSpace: 'nowrap' }}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── StoreModal ───────────────────────────────────────────────────────────────

interface StoreModalProps {
  stores: Store[];
  userStoreIds: number[];
  userId: number;
  onClose: () => void;
  onRefresh: () => void;
}

function StoreModal({ stores, userStoreIds, userId, onClose, onRefresh }: StoreModalProps) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState('Yandex Market');
  const [newApiKey, setNewApiKey] = useState('');
  const [newBusinessId, setNewBusinessId] = useState('');
  const [newCampaignIds, setNewCampaignIds] = useState('');
  const [newRoi, setNewRoi] = useState('0.2');
  const [newTax, setNewTax] = useState('0.06');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleToggleStore(storeId: number, has: boolean) {
    if (has) {
      await removeUserStore(userId, storeId);
    } else {
      await addUserStore(userId, storeId);
    }
    onRefresh();
  }

  async function handleCreateStore() {
    if (!newName) { setError('Введите название магазина'); return; }
    setSaving(true);
    setError('');
    try {
      const s = await createStore({
        name: newName, platform: newPlatform,
        default_roi: parseFloat(newRoi), tax_rate: parseFloat(newTax),
        api_key: newApiKey, business_id: newBusinessId, campaign_ids: newCampaignIds,
      });
      await addUserStore(userId, s.id);
      onRefresh();
      setShowNew(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 500, maxHeight: '90vh', overflow: 'auto', padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>Управление магазинами</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: '#6b7280' }}>✕</button>
        </div>

        {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '13px' }}>{error}</div>}

        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px', fontWeight: 600 }}>СУЩЕСТВУЮЩИЕ МАГАЗИНЫ</div>
          {stores.map(s => {
            const has = userStoreIds.includes(s.id);
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div>
                  <span style={{ fontWeight: 500, fontSize: '14px' }}>{s.name}</span>
                  <span style={{ marginLeft: '8px', fontSize: '12px', color: '#6b7280' }}>{s.platform}</span>
                </div>
                <button
                  onClick={() => handleToggleStore(s.id, has)}
                  style={{
                    padding: '4px 12px', borderRadius: '6px', border: '1px solid',
                    cursor: 'pointer', fontSize: '12px', fontWeight: 500,
                    background: has ? '#fee2e2' : '#dcfce7',
                    color: has ? '#b91c1c' : '#166534',
                    borderColor: has ? '#fca5a5' : '#86efac',
                  }}
                >
                  {has ? 'Убрать доступ' : 'Дать доступ'}
                </button>
              </div>
            );
          })}
        </div>

        <div>
          <button
            onClick={() => setShowNew(v => !v)}
            style={{ fontSize: '13px', color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {showNew ? '▲' : '▼'} Добавить новый магазин
          </button>

          {showNew && (
            <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={labelStyle}>Название *</label>
                  <input style={inputStyle} value={newName} onChange={e => setNewName(e.target.value)} placeholder="shop_name" />
                </div>
                <div>
                  <label style={labelStyle}>Площадка</label>
                  <select className="select-input" style={{ width: '100%' }} value={newPlatform} onChange={e => setNewPlatform(e.target.value)}>
                    <option>Yandex Market</option>
                    <option>Ozon</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={labelStyle}>API Key</label>
                <input style={inputStyle} value={newApiKey} onChange={e => setNewApiKey(e.target.value)} placeholder="Ключ API" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={labelStyle}>Business ID</label>
                  <input style={inputStyle} value={newBusinessId} onChange={e => setNewBusinessId(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Campaign IDs (через запятую)</label>
                  <input style={inputStyle} value={newCampaignIds} onChange={e => setNewCampaignIds(e.target.value)} placeholder="123456, 789012" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={labelStyle}>ROI по умолчанию</label>
                  <input style={inputStyle} type="number" step="0.01" value={newRoi} onChange={e => setNewRoi(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Ставка налога</label>
                  <input style={inputStyle} type="number" step="0.01" value={newTax} onChange={e => setNewTax(e.target.value)} />
                </div>
              </div>
              <button onClick={handleCreateStore} disabled={saving} className="button" style={{ alignSelf: 'flex-start' }}>
                {saving ? 'Создание...' : 'Создать и добавить'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── UserRow ─────────────────────────────────────────────────────────────────

interface UserRowProps {
  user: AdminUser;
  stores: Store[];
  onRefresh: () => void;
}

function UserRow({ user, stores, onRefresh }: UserRowProps) {
  const [editing, setEditing] = useState(false);
  const [storeModal, setStoreModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = user.payment_due_date && user.payment_due_date < today && !user.paid_at;

  async function handleSave(data: UserFormData) {
    await updateUser(user.id, data);
    setEditing(false);
    onRefresh();
  }

  async function handleDelete() {
    await deleteUser(user.id);
    onRefresh();
  }

  async function handleConfirmPayment() {
    await updateUser(user.id, { paid_at: today });
    onRefresh();
  }

  async function handleBlock() {
    await updateUser(user.id, { is_active: !user.is_active });
    onRefresh();
  }

  const storeNames = user.store_ids.map(id => stores.find(s => s.id === id)?.name ?? `#${id}`).join(', ');

  return (
    <>
      {editing && (
        <UserForm
          title="Редактировать пользователя"
          initial={user}
          onSave={handleSave}
          onCancel={() => setEditing(false)}
        />
      )}
      {storeModal && (
        <StoreModal
          stores={stores}
          userStoreIds={user.store_ids}
          userId={user.id}
          onClose={() => setStoreModal(false)}
          onRefresh={onRefresh}
        />
      )}
      <tr style={{ borderBottom: '1px solid #f3f4f6', opacity: user.is_active ? 1 : 0.55 }}>
        <td style={{ padding: '10px 14px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{user.display_name}</div>
          <div style={{ fontSize: '12px', color: '#6b7280' }}>{user.login}</div>
          {user.comment && <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{user.comment}</div>}
        </td>
        <td style={{ padding: '10px 14px' }}>
          <span style={{
            display: 'inline-block', padding: '3px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 600,
            background: !user.is_active ? '#fee2e2' : user.is_admin ? '#dbeafe' : '#dcfce7',
            color: !user.is_active ? '#b91c1c' : user.is_admin ? '#1d4ed8' : '#166534',
          }}>
            {!user.is_active ? 'Заблокирован' : user.is_admin ? 'Администратор' : 'Активен'}
          </span>
        </td>
        <td style={{ padding: '10px 14px', fontSize: '13px' }}>
          {user.payment_due_date ? (
            <div>
              <div style={{ color: isOverdue ? '#b91c1c' : '#374151' }}>
                {isOverdue ? '⚠ ' : ''}{user.payment_due_date}
              </div>
              {user.paid_at
                ? <div style={{ fontSize: '11px', color: '#16a34a' }}>Оплачено {user.paid_at}</div>
                : <button onClick={handleConfirmPayment} style={{ fontSize: '11px', color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '2px' }}>Подтвердить оплату</button>
              }
            </div>
          ) : <span style={{ color: '#9ca3af' }}>—</span>}
        </td>
        <td style={{ padding: '10px 14px', fontSize: '13px', color: '#374151' }}>
          {storeNames || <span style={{ color: '#9ca3af' }}>нет доступа</span>}
          <button
            onClick={() => setStoreModal(true)}
            style={{ display: 'block', marginTop: '4px', fontSize: '11px', color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            Управление магазинами
          </button>
        </td>
        <td style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button onClick={() => setEditing(true)} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '12px' }}>
              Изменить
            </button>
            <button onClick={handleBlock} style={{
              padding: '4px 10px', borderRadius: '6px', border: '1px solid',
              cursor: 'pointer', fontSize: '12px',
              background: user.is_active ? '#fef3c7' : '#dcfce7',
              color: user.is_active ? '#92400e' : '#166534',
              borderColor: user.is_active ? '#fde68a' : '#86efac',
            }}>
              {user.is_active ? 'Заблокировать' : 'Разблокировать'}
            </button>
            {confirmDelete ? (
              <>
                <button onClick={handleDelete} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #fca5a5', background: '#fee2e2', color: '#b91c1c', cursor: 'pointer', fontSize: '12px' }}>
                  Подтвердить удаление
                </button>
                <button onClick={() => setConfirmDelete(false)} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', fontSize: '12px' }}>
                  Отмена
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #fca5a5', background: 'white', color: '#b91c1c', cursor: 'pointer', fontSize: '12px' }}>
                Удалить
              </button>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── AdminPage ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try {
      const [u, s] = await Promise.all([fetchAdminUsers(), fetchAllStores()]);
      setUsers(u);
      setStores(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(data: UserFormData) {
    await createUser(data);
    setShowCreate(false);
    load();
  }

  if (loading) return <LoadingCats />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h1 style={{ margin: 0 }}>Администрирование</h1>
        <button className="button" onClick={() => setShowCreate(true)}>+ Добавить пользователя</button>
      </div>

      {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 16px', borderRadius: '8px', marginBottom: '16px' }}>{error}</div>}

      {showCreate && (
        <UserForm
          title="Новый пользователь"
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {users.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
          Нет пользователей. Добавьте первого клиента.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                {['Пользователь', 'Статус', 'Оплата', 'Магазины', 'Действия'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '12px', fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <UserRow key={u.id} user={u} stores={stores} onRefresh={load} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
