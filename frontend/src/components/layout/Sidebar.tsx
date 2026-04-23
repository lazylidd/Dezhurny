import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { fetchAllStores } from '../../api/stores';
import type { Store } from '../../types/store';

const STORE_SLUG: Record<number, string> = { 1: 'yam16', 2: 'yam21' };

function storeSlug(store: Store): string {
  return STORE_SLUG[store.id] ?? String(store.id);
}

function StoreNavItem({ store }: { store: Store }) {
  const slug = storeSlug(store);
  const location = useLocation();
  const isStorePage = location.pathname === `/store/${slug}` || location.pathname.startsWith(`/store/${slug}/`);
  const [open, setOpen] = useState(isStorePage);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderRadius: '8px',
          background: open ? '#1f2937' : 'transparent',
          color: isStorePage ? 'white' : '#d1d5db',
          border: 'none',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: isStorePage ? 600 : 400,
          textAlign: 'left',
        }}
      >
        {store.display_name ?? store.name}
        <span style={{ fontSize: '10px', opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
          <NavLink
            to={`/store/${slug}`}
            end
            className={({ isActive }) =>
              isActive ? 'sidebar__link sidebar__link--active sidebar__link--sub' : 'sidebar__link sidebar__link--sub'
            }
          >
            Ассортимент
          </NavLink>
          <NavLink
            to={`/store/${slug}/analytics`}
            className={({ isActive }) =>
              isActive ? 'sidebar__link sidebar__link--active sidebar__link--sub' : 'sidebar__link sidebar__link--sub'
            }
          >
            Аналитика
          </NavLink>
        </div>
      )}
    </div>
  );
}

function CollapseSection({ label, isActive, children }: { label: string; isActive: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(isActive);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderRadius: '8px',
          background: open ? '#1f2937' : 'transparent',
          color: isActive ? 'white' : '#d1d5db',
          border: 'none', cursor: 'pointer', fontSize: '14px',
          fontWeight: isActive ? 600 : 400, textAlign: 'left',
        }}
      >
        {label}
        <span style={{ fontSize: '10px', opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
          {children}
        </div>
      )}
    </>
  );
}

interface Props {
  isAdmin: boolean;
  storeIds: number[];
}

export default function Sidebar({ isAdmin, storeIds }: Props) {
  const [stores, setStores] = useState<Store[]>([]);
  const location = useLocation();

  useEffect(() => {
    fetchAllStores().then(setStores).catch(() => {});
  }, []);

  const subLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'sidebar__link sidebar__link--active sidebar__link--sub'
      : 'sidebar__link sidebar__link--sub';

  const visibleStores = storeIds.length > 0
    ? stores.filter(s => storeIds.includes(s.id))
    : stores;

  const isStorePage = location.pathname.startsWith('/store/');
  const isPricePage = location.pathname.startsWith('/upload-prices') || location.pathname.startsWith('/matching');
  const isSysPage = location.pathname.startsWith('/admin') || location.pathname.startsWith('/settings');

  return (
    <aside className="sidebar">
      <div className="sidebar__logo">DEZHURNY</div>

      <nav className="sidebar__nav">
        <NavLink
          to="/dashboard"
          className={({ isActive }) => isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'}
        >
          Главная
        </NavLink>

        <NavLink
          to="/orders"
          className={({ isActive }) => isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'}
        >
          Продажи
        </NavLink>

        <NavLink
          to="/assembly"
          className={({ isActive }) => isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'}
        >
          Сборка заказов
        </NavLink>

        <CollapseSection label="Магазины" isActive={isStorePage}>
          {visibleStores.map((s) => (
            <StoreNavItem key={s.id} store={s} />
          ))}
        </CollapseSection>

        {isAdmin && (
          <CollapseSection label="Цены и ассортимент" isActive={isPricePage}>
            <NavLink to="/upload-prices" className={subLinkClass}>
              Загрузка прайсов
            </NavLink>
            <NavLink to="/matching" className={subLinkClass}>
              Сопоставление
            </NavLink>
          </CollapseSection>
        )}

        <CollapseSection label="Система" isActive={isSysPage}>
          {isAdmin && (
            <NavLink to="/admin" className={subLinkClass}>
              Администрирование
            </NavLink>
          )}
          <NavLink to="/settings" className={subLinkClass}>
            Настройки
          </NavLink>
        </CollapseSection>
      </nav>
    </aside>
  );
}
