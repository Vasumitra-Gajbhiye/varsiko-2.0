import { kv } from '@vercel/kv';

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 30;

export async function rateLimit(identifier: string): Promise<{ ok: boolean; remaining: number }> {
  const key = `ratelimit:${identifier}`;
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, WINDOW_SECONDS);
  }
  return { ok: count <= MAX_REQUESTS, remaining: Math.max(0, MAX_REQUESTS - count) };
}

export async function cacheSession(sessionId: string, payload: Record<string, unknown>) {
  await kv.set(`session:${sessionId}`, payload, { ex: 3600 });
}

export async function readSession<T>(sessionId: string): Promise<T | null> {
  return kv.get<T>(`session:${sessionId}`);
}

export async function trackView(slug: string) {
  await kv.zincrby('product:views', 1, slug);
}

export async function topProducts(limit = 10): Promise<string[]> {
  return kv.zrange<string[]>('product:views', 0, limit - 1, { rev: true });
}
