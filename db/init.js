// One-shot DB bootstrap: drop dalhangari objects, run schema.sql, run seed.sql.
// Usage:  node db/init.js
//
// Reads DATABASE_URL from process.env (loaded from .env if present).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// minimal .env loader (no dotenv dep needed)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const connectionString = (process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const DROP_SQL = `
DROP VIEW    IF EXISTS v_product_card                CASCADE;
DROP TABLE   IF EXISTS order_items                   CASCADE;
DROP TABLE   IF EXISTS orders                        CASCADE;
DROP TABLE   IF EXISTS wishlist_items                CASCADE;  -- 구버전 (현재 미사용)
DROP TABLE   IF EXISTS cart_items                    CASCADE;  -- 구버전 (현재 미사용)
DROP TABLE   IF EXISTS product_images                CASCADE;
DROP TABLE   IF EXISTS products                      CASCADE;
DROP TABLE   IF EXISTS categories                    CASCADE;
DROP TABLE   IF EXISTS artists                       CASCADE;
DROP TABLE   IF EXISTS users                         CASCADE;
DROP TYPE    IF EXISTS order_status                  CASCADE;
DROP SEQUENCE IF EXISTS orders_seq                   CASCADE;
DROP FUNCTION IF EXISTS touch_updated_at()           CASCADE;
`;

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const seed   = fs.readFileSync(path.join(__dirname, 'seed.sql'),   'utf8');

  console.log('1) Dropping existing dalhangari objects (if any) ...');
  await pool.query(DROP_SQL);

  console.log('2) Applying schema.sql ...');
  await pool.query(schema);

  console.log('3) Applying seed.sql ...');
  await pool.query(seed);

  console.log('4) Verifying ...');
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('artists','categories','products','product_images',
                          'users','orders','order_items')
     ORDER BY table_name
  `);
  console.log('   tables:', tables.map(r => r.table_name).join(', '));

  const { rows: pcount } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  console.log('   products seeded:', pcount[0].n);

  await pool.end();
  console.log('\nDone. Database is ready.');
}

run().catch((err) => {
  console.error('FAILED:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
