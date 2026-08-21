const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TAG_SQL = `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`;
const UNREAD_SQL = `SELECT id FROM news WHERE matched_tags && $1::text[] AND published_at > NOW() - INTERVAL '90 days' AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = $2 AND r.news_id = news.id) ORDER BY published_at DESC LIMIT 21`;
const HIST_SQL = `SELECT id FROM news WHERE matched_tags && $1::text[] AND published_at > NOW() - INTERVAL '90 days' AND id IN (SELECT news_id FROM user_news_reads WHERE user_id = $2) ORDER BY published_at DESC LIMIT 51`;
const HIST_EXISTS_SQL = `SELECT n.id FROM news n WHERE n.matched_tags && $1::text[] AND n.published_at > NOW() - INTERVAL '90 days' AND EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = $2 AND r.news_id = n.id) ORDER BY n.published_at DESC LIMIT 51`;

async function explain(label, sql, params) {
  const r = await pool.query('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params);
  console.log('\n== ' + label + ' ==');
  for (const row of r.rows) console.log('  ' + Object.values(row)[0]);
}

(async () => {
  const u = await pool.query(`SELECT user_id, COUNT(*)::int c FROM user_news_reads GROUP BY user_id ORDER BY 2 DESC LIMIT 1`);
  const uid = process.env.PROBE_UID || u.rows[0].user_id;
  const tags = await pool.query(TAG_SQL, [uid]);
  const tagIds = tags.rows.map(r => r.tag_id);
  console.log('user:', uid, '| tags:', tagIds.length, '| reads:', u.rows[0].c);

  await explain('UNREAD NOT EXISTS', UNREAD_SQL, [tagIds, uid]);
  await explain('HISTORY IN', HIST_SQL, [tagIds, uid]);
  await explain('HISTORY EXISTS', HIST_EXISTS_SQL, [tagIds, uid]);

  const smoke = await pool.query(UNREAD_SQL, [tagIds, uid]);
  console.log('\nunread rows:', smoke.rows.length);

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
