import { query } from '../config/db';

/**
 * Build period-specific SQL for popular tags.
 *
 * Strategy:
 * 1. window_tags — scan ONLY the requested period window and count tags there.
 *    This gives the ordering-period count for top-N directly.
 * 2. full_counts — for top tags, use per-tag GIN lookups to compute the other
 *    two counts. Each tag is counted independently, so co-occurring tags
 *    never pollute each other's counts. For 30d the full_counts scan is
 *    narrowed to 7 days because we only need 24h/7d (30d already known).
 */
export function buildPopularTagsSql(period: string, limit: number): string {
  const cfg: Record<string, {
    windowFilter: string;
    windowCol: string;
    fullFilter: string;
    fullCols: string;
  }> = {
    '24h': {
      windowFilter: "n.published_at > NOW() - INTERVAL '24 hours'",
      windowCol: 'articles_24h',
      fullFilter: "n.published_at > NOW() - INTERVAL '30 days'",
      fullCols: `
        COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '24 hours') AS articles_24h,
        COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '7 days')   AS articles_7d,
        COUNT(*)                                                                          AS articles_30d
      `,
    },
    '7d': {
      windowFilter: "n.published_at > NOW() - INTERVAL '7 days'",
      windowCol: 'articles_7d',
      fullFilter: "n.published_at > NOW() - INTERVAL '30 days'",
      fullCols: `
        COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '24 hours') AS articles_24h,
        COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '7 days')   AS articles_7d,
        COUNT(*)                                                                          AS articles_30d
      `,
    },
    '30d': {
      windowFilter: "n.published_at > NOW() - INTERVAL '30 days'",
      windowCol: 'articles_30d',
      fullFilter: "n.published_at > NOW() - INTERVAL '7 days'",
      fullCols: `
        COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '24 hours') AS articles_24h,
        COUNT(*)                                                             AS articles_7d,
        tt.articles_30d                                                      AS articles_30d
      `,
    },
  };
  const { windowFilter, windowCol, fullFilter, fullCols } = cfg[period];

  return `
    WITH window_tags AS (
      SELECT m.tag AS tag_id, COUNT(*) AS ${windowCol}
      FROM news n
      CROSS JOIN LATERAL unnest(n.matched_tags) AS m(tag)
      WHERE ${windowFilter}
      GROUP BY m.tag
      ORDER BY ${windowCol} DESC
      LIMIT $1
    ),
    full_counts AS (
      SELECT tt.tag_id,
             ${fullCols}
      FROM window_tags tt
      JOIN news n ON ${fullFilter}
                  AND n.matched_tags && ARRAY[tt.tag_id]
      GROUP BY tt.tag_id, tt.${windowCol}
    )
    SELECT t.tag_id, t.tag_name, t.tag_type,
           fc.articles_24h, fc.articles_7d, fc.articles_30d
    FROM full_counts fc
    JOIN user_defined_tags t ON t.tag_id = fc.tag_id
    ORDER BY fc.${windowCol} DESC
    LIMIT $1
  `;
}

export async function computePopularTags(period: string, limit: number): Promise<any[]> {
  const orderCol = {
    '24h': 'articles_24h',
    '7d': 'articles_7d',
    '30d': 'articles_30d',
  }[period] as string;

  const result = await query(buildPopularTagsSql(period, limit), [limit]);

  return result.rows.map((row: any) => ({
    tag_id: row.tag_id,
    tag_name: row.tag_name,
    tag_type: row.tag_type,
    news_count: parseInt(row[orderCol]) || 0,
    articles_24h: parseInt(row.articles_24h) || 0,
    articles_7d: parseInt(row.articles_7d) || 0,
    articles_30d: parseInt(row.articles_30d) || 0,
  }));
}
