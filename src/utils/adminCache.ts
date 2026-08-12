/**
 * In-memory TTL cache for admin GET endpoints.
 *
 * Mirrors the existing tagCache pattern, but adds:
 * - parallel request deduplication (in-flight promises),
 * - per-key TTL,
 * - a size cap to avoid unbounded growth.
 *
 * Errors are never cached.
 */

const store = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();

// Reasonable cap: 6 endpoints × limited parameter space. Eviction is FIFO.
const MAX_KEYS = 200;

/**
 * Return a cached value or compute it, cache it, and return it.
 * Parallel calls with the same key wait on a single computation.
 */
export async function adminCached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.data as T;
  }

  const existing = inflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const p = compute()
    .then((data) => {
      // Prevent unbounded growth under unusual query combinations.
      if (store.size >= MAX_KEYS && !store.has(key)) {
        const first = store.keys().next().value;
        if (first !== undefined) {
          store.delete(first);
        }
      }
      store.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/** Drop all keys matching the given prefix. Call from mutations that change the underlying data. */
export function adminCacheInvalidate(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k);
    }
  }
}

/** Drop every cached admin entry. Useful for tests or manual cache resets. */
export function adminCacheClear(): void {
  store.clear();
  inflight.clear();
}
