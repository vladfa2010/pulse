/**
 * In-memory cache for popular tags.
 * Shared between /admin/tags and /news/tags/popular.
 */

interface CachedTags {
  tags: any[]
  ts: number
}

const cache = new Map<string, CachedTags>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function getCacheKey(period: string, limit: number): string {
  return `${period}:${limit}`
}

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

export function setCachedPopularTags(period: string, limit: number, tags: any[]): void {
  cache.set(getCacheKey(period, limit), { tags, ts: Date.now() })
}

export function invalidatePopularTagsCache(): void {
  cache.clear()
}
