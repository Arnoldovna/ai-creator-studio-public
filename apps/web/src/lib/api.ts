'use client';
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status: number, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: 'no-store',
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const issues = data?.issues as { path: string; message: string }[] | undefined;
    const detail = issues?.length ? `: ${issues.map((i) => `${i.path || 'Feld'} – ${i.message}`).join('; ')}` : '';
    throw new ApiError(`${data?.error ?? `HTTP ${res.status}`}${detail}`, res.status, issues);
  }
  return data as T;
}

/** Minimal data hook: load + reload, with error state. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.click();
}
