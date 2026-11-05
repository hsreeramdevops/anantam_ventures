import { Doc } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'fetch',
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('av:unauthorized'));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: (url: string) => request<void>('DELETE', url),

  list: (type: string) => request<{ items: Doc[]; canWrite: boolean }>('GET', `/api/entities/${type}`),
  create: (type: string, body: Record<string, unknown>) => request<Doc>('POST', `/api/entities/${type}`, body),
  update: (type: string, id: string, body: Record<string, unknown>) => request<Doc>('PUT', `/api/entities/${type}/${id}`, body),
  remove: (type: string, id: string) => request<void>('DELETE', `/api/entities/${type}/${id}`),

  upload: (folder: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ name: string }>('POST', `/api/files?folder=${folder}`, fd);
  },
};

export const fileUrl = (name: string) => `/api/files/${name.split('/').map(encodeURIComponent).join('/')}`;
