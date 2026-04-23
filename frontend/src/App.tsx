import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { checkMe, type MeResponse } from './api/auth';
import AppLayout from './components/layout/AppLayout';
import AdminPage from './pages/AdminPage';
import DashboardPage from './pages/DashboardPage';
import SystemSettingsPage from './pages/SystemSettingsPage';
import LoginPage from './pages/LoginPage';
import MatchingPage from './pages/MatchingPage';
import SalesPage from './pages/SalesPage';
import StorePage from './pages/StorePage';
import UploadPricesPage from './pages/UploadPricesPage';
import AssemblyPage from './pages/AssemblyPage';
import OrdersListPage from './pages/OrdersListPage';

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    checkMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return null;

  const authenticated = me !== null;

  return (
    <Routes>
      <Route
        path="/login"
        element={
          authenticated
            ? <Navigate to="/dashboard" replace />
            : <LoginPage onLogin={() => checkMe().then(setMe).catch(() => {})} />
        }
      />
      <Route
        path="/"
        element={
          authenticated
            ? <AppLayout isAdmin={me.is_admin} storeIds={me.store_ids} />
            : <Navigate to="/login" replace />
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="store/:storeId" element={<StorePage />} />
        <Route path="upload-prices" element={<UploadPricesPage />} />
        <Route path="matching" element={<MatchingPage />} />
        <Route path="store/:storeId/sales" element={<SalesPage />} />
        <Route path="store/:storeId/analytics" element={<OrdersListPage />} />
        <Route path="assembly" element={<AssemblyPage />} />
        <Route path="orders" element={<OrdersListPage />} />
        <Route
          path="admin"
          element={me?.is_admin ? <AdminPage /> : <Navigate to="/dashboard" replace />}
        />
        <Route path="settings" element={<SystemSettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
