// Read-only выполнение SQL против SQLite-файла БД в отдельном процессе.
// Нужен, потому что сервер держит sql.js БД в своей памяти: из тест-процесса
// его записи не видны, а файл — единственная точка синхронизации.
// Использование: node scripts/lib/sqlite-exec.js <file.db> "<sql>" ["<sql>"...]
// Вывод: JSON-массив массивов строк (по одному на каждый запрос).
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = process.argv[2];

const path = require('path');

(async () => {
  const sqlite = require(path.join(__dirname, '..', '..', 'dist', 'config', 'db-sqlite'));
  // init логирует в stdout — перенаправляем в stderr, чтобы stdout остался чистым JSON
  const origLog = console.log;
  console.log = (...a) => console.error(...a);
  await sqlite.initSQLite();
  console.log = origLog;
  // Только чтение — exit-хук saveDb не нужен
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  const out = [];
  for (const sql of process.argv.slice(3)) {
    const r = await sqlite.query(sql);
    out.push(r.rows);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
