import { apiFetch } from './client';

export interface AdminUser {
  id: number;
  login: string;
  display_name: string;
  comment: string | null;
  payment_due_date: string | null;
  paid_at: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string | null;
  store_ids: number[];
}

export interface AdminStore {
  id: number;
  name: string;
  platform: string;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  return apiFetch('/admin/users');
}

export async function createUser(data: {
  login: string; password: string; display_name: string;
  comment?: string; payment_due_date?: string; is_admin?: boolean;
}): Promise<{ id: number; login: string }> {
  return apiFetch('/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateUser(id: number, data: Partial<{
  login: string; password: string; display_name: string; comment: string;
  payment_due_date: string; paid_at: string; is_active: boolean; is_admin: boolean;
}>): Promise<void> {
  await apiFetch(`/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteUser(id: number): Promise<void> {
  await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
}

export async function addUserStore(userId: number, storeId: number): Promise<void> {
  await apiFetch(`/admin/users/${userId}/stores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId }),
  });
}

export async function removeUserStore(userId: number, storeId: number): Promise<void> {
  await apiFetch(`/admin/users/${userId}/stores/${storeId}`, { method: 'DELETE' });
}

export async function createStore(data: {
  name: string; platform: string; default_roi?: number; tax_rate?: number;
  api_key?: string; business_id?: string; campaign_ids?: string;
}): Promise<AdminStore> {
  return apiFetch('/admin/stores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateStoreCredentials(storeId: number, data: {
  api_key?: string; business_id?: string; campaign_ids?: string;
  name?: string; platform?: string; default_roi?: number; tax_rate?: number;
}): Promise<void> {
  await apiFetch(`/admin/stores/${storeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
