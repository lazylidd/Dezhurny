import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

interface Props {
  isAdmin: boolean;
  storeIds: number[];
}

export default function AppLayout({ isAdmin, storeIds }: Props) {
  return (
    <div className="app-shell">
      <Sidebar isAdmin={isAdmin} storeIds={storeIds} />
      <main className="page-content">
        <Outlet />
      </main>
    </div>
  );
}
