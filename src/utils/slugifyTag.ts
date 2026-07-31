// ═══════════════════════════════════════════════════════════════════════════
// Tag slug generator — PULSE tag_id convention
// Keeps Cyrillic, spaces → underscores, max 50 chars, no hash prefix.
// ═══════════════════════════════════════════════════════════════════════════

export function slugifyTagId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, '')   // keep letters, digits, spaces
    .replace(/\s+/g, '_')               // spaces → underscores
    .replace(/_+/g, '_')                 // collapse multiple underscores
    .replace(/^_+|_+$/g, '')             // trim leading/trailing underscores
    .substring(0, 50);                  // cap at 50 chars
}

export function isFallbackTagName(tagName: string, ticker: string): boolean {
  return tagName.toUpperCase() === ticker.toUpperCase();
}
