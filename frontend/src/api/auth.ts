const BASE_URL = '/api';

export interface MeResponse {
  ok: boolean;
  is_admin: boolean;
  store_ids: number[];
  display_name: string | null;
  from_db: boolean;
}

export async function checkMe(): Promise<MeResponse> {
  const res = await fetch(`${BASE_URL}/me`, { credentials: 'include' });
  if (!res.ok) throw new Error('Not authenticated');
  return res.json();
}

export async function login(login: string, password: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ login, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Ошибка входа');
  }
}

export async function logout(): Promise<void> {
  await fetch(`${BASE_URL}/logout`, { method: 'POST', credentials: 'include' });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/me/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Ошибка смены пароля');
  }
}
