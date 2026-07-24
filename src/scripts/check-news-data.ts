import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const USE_SQLITE = process.env.USE_SQLITE === 'true';

  if (USE_SQLITE) {
    const sqlite = await import('../config/db-sqlite');
    await sqlite.initSQLite();
  }

  const { logNewsDataCheck } = await import('../services/newsDataCheck');
  await logNewsDataCheck();

  process.exit(0);
}

main().catch((err) => {
  console.error('News data check failed:', err);
  process.exit(1);
});
