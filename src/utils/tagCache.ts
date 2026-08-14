/**
 * In-memory cache for popular tags.
 * Shared between /admin/tags and /news/tags/popular.
 *
 * Supports:
 * - simple TTL get/set (backward compat for admin warm-up),
 * - stale-while-revalidate,
 * - in-flight request deduplication (thundering herd protection).
 */

interface CachedTags {
  tags: any[]
  ts: number
}

const cache = new Map<string, CachedTags>()
const inflight = new Map<string, Promise<any[]>>()

const CACHE_TTL = 5 * 60 * 1000        // 5 minutes — fresh data
const STALE_TTL = 60 * 60 * 1000       // up to 1 hour stale accepted while refreshing in background

function getCacheKey(period: string, limit: number): string {
  return `${period}:${limit}`
}

// Backward-compatible simple getter used by /admin/tags warm-up and manual reads.
export function getCachedPopularTags(period: string, limit: number): any[] | null {
  const key = getCacheKey(period, limit)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.tags
}

// Backward-compatible setter used by /admin/tags warm-up.
export function setCachedPopularTags(period: string, limit: number, tags: any[]): void {
  cache.set(getCacheKey(period, limit), { tags, ts: Date.now() })
}

export function invalidatePopularTagsCache(): void {
  cache.clear()
  // Deliberately leave inflight promises alone: they will complete and overwrite cache.
}

/**
 * Get popular tags with stale-while-revalidate semantics and in-flight dedup.
 *
 * - Fresh entry (<= CACHE_TTL): return immediately.
 * - Stale entry (CACHE_TTL < age <= STALE_TTL): return stale now, refresh in background
 *   (single compute shared by all concurrent callers).
 * - Missing or very stale (> STALE_TTL): wait for a single compute, shared by all callers.
 */
export async function popularTagsCached(
  period: string,
  limit: number,
  compute: () => Promise<any[]>
): Promise<any[]> {
  const key = getCacheKey(period, limit)
  const entry = cache.get(key)

  // Fresh — instant.
  if (entry && Date.now() - entry.ts <= CACHE_TTL) {
    return entry.tags
  }

  // Stale — return immediately and refresh in background (one compute for all callers).
  if (entry && Date.now() - entry.ts <= STALE_TTL) {
    if (!inflight.has(key)) {
      const p = compute()
        .then((tags) => {
          cache.set(key, { tags, ts: Date.now() })
          return tags
        })
        .catch((err) => {
          console.error('[PopularTags] background refresh error:', err?.message)
          return entry.tags
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, p)
    }
    return entry.tags
  }

  // Missing or very stale — synchronous compute, deduplicated across concurrent callers.
  if (!inflight.has(key)) {
    const p = compute()
      .then((tags) => {
        cache.set(key, { tags, ts: Date.now() })
        return tags
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, p)
  }

  return inflight.get(key)!
}
