type CacheEntry<T> = {
  expiresAt: number;
  value?: T;
  pending?: Promise<T>;
};

const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry<unknown>>();

function prune(now: number) {
  for (const [key, entry] of cache) {
    if (!entry.pending && entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * Small per-process result cache. Keys must always include tenant and every
 * input that changes the result. Pending promises are shared to prevent a
 * burst of identical page loads from hitting Postgres simultaneously.
 */
export async function withServerResultCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const current = cache.get(key) as CacheEntry<T> | undefined;
  if (current?.pending) return current.pending;
  if (current?.value !== undefined && current.expiresAt > now) return current.value;

  prune(now);
  const pending = loader();
  cache.set(key, { expiresAt: now + ttlMs, pending });
  try {
    const value = await pending;
    cache.set(key, { expiresAt: Date.now() + ttlMs, value });
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export function invalidateServerResultCache(prefix: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
