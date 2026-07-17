// ═══════════════════════════════════════════════════════════════════════════
// Slug generator for news articles
// slug = {transliterated_title}-{uuid_first_8}
// ═══════════════════════════════════════════════════════════════════════════

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ы: 'y', э: 'e', ю: 'yu', я: 'ya',
  ъ: '', ь: '',
};

function transliterate(text: string): string {
  return text
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      const lat = CYRILLIC_TO_LATIN[lower];
      if (!lat) return ch;
      return ch === ch.toUpperCase()
        ? lat.charAt(0).toUpperCase() + lat.slice(1)
        : lat;
    })
    .join('');
}

export function slugify(title: string, id: string): string {
  const normalized = transliterate(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .replace(/\s+/g, '-')            // spaces → dashes
    .replace(/-+/g, '-')             // collapse multiple dashes
    .replace(/^-|-$/g, '')           // trim dashes
    .substring(0, 80);               // max 80 chars

  const suffix = id.replace(/-/g, '').substring(0, 8);
  return `${normalized || 'news'}-${suffix}`;
}
