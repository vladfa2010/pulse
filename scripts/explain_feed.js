const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const u = await pool.query(`
    SELECT user_id, COUNT(*)::int c
    FROM user_news_reads
    GROUP BY user_id
    ORDER BY c DESC
    LIMIT 1
  `);
  const userId = u.rows[0].user_id;

  const tags = await pool.query(
    `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
    [userId]
  );
  const tagIds = tags.rows.map(r => r.tag_id);
  console.log(`user: ${userId}, reads: ${u.rows[0].c}, active tags: ${tagIds.length}`);

  const tf = `published_at > NOW() - INTERVAL '90 days'`;
  const probes = [
    ['COUNT history', `SELECT COUNT(*) as count FROM news WHERE matched_tags && $1::text[] AND id IN (SELECT news_id FROM user_news_reads WHERE user_id = $2) AND ${tf}`, [tagIds, userId]],
    ['PAGE history', `SELECT id FROM news WHERE matched_tags && $1::text[] AND id IN (SELECT news_id FROM user_news_reads WHERE user_id = $2) AND ${tf} ORDER BY published_at DESC LIMIT 51 OFFSET 0`, [tagIds, userId]],
    ['COUNT unread', `SELECT COUNT(*) as count FROM news WHERE matched_tags && $1::text[] AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $2) AND ${tf}`, [tagIds, userId]],
    ['PAGE unread', `SELECT id FROM news WHERE matched_tags && $1::text[] AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $2) AND ${tf} ORDER BY published_at DESC LIMIT 51 OFFSET 0`, [tagIds, userId]],
  ];

  for (const [name, sql, params] of probes) {
    const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    console.log(`\n=== ${name} ===\n` + r.rows.map(x => Object.values(x)[0]).join('\n'));
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
