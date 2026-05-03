// ============================================================================
// Dalhangari (달항아리) — Express server
// Single-file backend: static hosting + auth + product API.
// Local:   `node server.js`   (PORT from .env, default 3000)
// Vercel:  module.exports = app   (serverless dual-mode)
// ============================================================================

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');

// ──────────────────────────────────────────────────────────────────────────
// 1. .env loader (no dotenv dep; mirrors db/init.js pattern)
// ──────────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const DATABASE_URL          = (process.env.DATABASE_URL          || '').trim();
const JWT_SECRET            = (process.env.JWT_SECRET            || '').trim();
const PORT                  = Number((process.env.PORT           || '3000').trim()) || 3000;
const TOSS_SECRET_KEY       = (process.env.TOSS_SECRET_KEY       || '').trim();
const IMAGEKIT_PUBLIC_KEY   = (process.env.IMAGEKIT_PUBLIC_KEY   || '').trim();
const IMAGEKIT_PRIVATE_KEY  = (process.env.IMAGEKIT_PRIVATE_KEY  || '').trim();
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim();
const ADMIN_EMAILS          = (process.env.ADMIN_EMAILS          || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!JWT_SECRET)   throw new Error('JWT_SECRET is not set');
if (!TOSS_SECRET_KEY) {
  console.warn('[warn] TOSS_SECRET_KEY is not set — /api/payments/confirm will return 500');
}
if (!IMAGEKIT_PRIVATE_KEY) {
  console.warn('[warn] IMAGEKIT_PRIVATE_KEY is not set — /api/imagekit-auth will return 500');
}
if (ADMIN_EMAILS.length === 0) {
  console.warn('[warn] ADMIN_EMAILS is empty — admin endpoints will reject everyone');
}

// ──────────────────────────────────────────────────────────────────────────
// 2. App init
// ──────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────────────────────────────────
// 3. DB pool — lazy init (cold-start safe on serverless)
// ──────────────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  // Don't crash the process on idle-client errors (e.g. pgbouncer disconnects)
  _pool.on('error', (err) => {
    console.error('[pg pool] idle client error:', err.message);
  });
  return _pool;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Helpers
// ──────────────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}
function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return fail(res, 401, '인증이 필요합니다.');
  try {
    const payload = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (_err) {
    return fail(res, 401, '유효하지 않은 토큰입니다.');
  }
}

// ADMIN_EMAILS 화이트리스트 기반 — 가벼운 데모용 권한 검사
function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    const email = String(req.user?.email || '').toLowerCase();
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return fail(res, 403, '관리자 권한이 필요합니다.');
    }
    return next();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 5. API routes — /api/auth
// ──────────────────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return fail(res, 400, '올바른 이메일 주소를 입력해주세요.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      return fail(res, 400, '비밀번호는 8자 이상이어야 합니다.');
    }
    const cleanName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 100) : null;

    const pool = getPool();

    const dup = await pool.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
    if (dup.rowCount > 0) return fail(res, 409, '이미 사용 중인 이메일입니다.');

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [email.toLowerCase(), cleanName, hash]
    );
    const user = rows[0];
    user.isAdmin = ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
    const token = signToken(user);
    return ok(res, { user, token }, 201);
  } catch (err) {
    console.error('[POST /api/auth/signup]', err);
    return fail(res, 500, '회원가입 처리 중 오류가 발생했습니다.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return fail(res, 400, '이메일과 비밀번호를 입력해주세요.');
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    const row = rows[0];
    // Generic message either way — don't leak which field is wrong.
    if (!row) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다.');

    const matched = await bcrypt.compare(password, row.password_hash);
    if (!matched) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다.');

    const user = { id: row.id, email: row.email, name: row.name };
    user.isAdmin = ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
    const token = signToken(user);
    return ok(res, { user, token });
  } catch (err) {
    console.error('[POST /api/auth/login]', err);
    return fail(res, 500, '로그인 처리 중 오류가 발생했습니다.');
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, email, name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return fail(res, 401, '유효하지 않은 토큰입니다.');
    user.isAdmin = ADMIN_EMAILS.includes(String(user.email || '').toLowerCase());
    return ok(res, { user });
  } catch (err) {
    console.error('[GET /api/auth/me]', err);
    return fail(res, 500, '사용자 정보 조회 중 오류가 발생했습니다.');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6. API routes — /api/products
// ──────────────────────────────────────────────────────────────────────────
// v_product_card columns: id, name, artist, category, price, image,
//                         description, specs, stock, is_active
function shapeProduct(row) {
  return {
    id: row.id,
    name: row.name,
    artist: row.artist,
    category: row.category,
    price: row.price,
    image: row.image,
    description: row.description,
    specs: row.specs,
  };
}

app.get('/api/products', async (_req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, artist, category, price, image, description, specs
         FROM v_product_card
        WHERE is_active = TRUE
        ORDER BY id`
    );
    return ok(res, rows.map(shapeProduct));
  } catch (err) {
    console.error('[GET /api/products]', err);
    return fail(res, 500, '상품 목록을 불러오지 못했습니다.');
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, artist, category, price, image, description, specs
         FROM v_product_card
        WHERE is_active = TRUE AND id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return fail(res, 404, '상품을 찾을 수 없습니다.');
    return ok(res, shapeProduct(rows[0]));
  } catch (err) {
    console.error('[GET /api/products/:id]', err);
    return fail(res, 500, '상품 정보를 불러오지 못했습니다.');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6.1. API routes — 카테고리 / 작가 (관리자 폼 select용)
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/categories', async (_req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, slug, name, display_order
         FROM categories
        WHERE is_active = TRUE
        ORDER BY display_order, id`
    );
    return ok(res, rows);
  } catch (err) {
    console.error('[GET /api/categories]', err);
    return fail(res, 500, '카테고리 조회 실패');
  }
});

app.get('/api/artists', async (_req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, slug, name, region FROM artists ORDER BY id`
    );
    return ok(res, rows);
  } catch (err) {
    console.error('[GET /api/artists]', err);
    return fail(res, 500, '작가 조회 실패');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6.2. API routes — ImageKit 업로드 인증 (클라이언트가 ImageKit으로 직접 업로드)
// ──────────────────────────────────────────────────────────────────────────
// 흐름:
//   1) 관리자 클라이언트가 GET /api/imagekit-auth → token/expire/signature 받음
//   2) 클라이언트가 ImageKit upload API에 직접 PUT/POST → URL 받음
//   3) 그 URL을 POST /api/admin/products body의 thumbnail_url로 전달
// 관리자만 호출 가능하도록 requireAdmin 적용.
app.get('/api/imagekit-auth', requireAdmin, (_req, res) => {
  try {
    if (!IMAGEKIT_PRIVATE_KEY) {
      return fail(res, 500, 'ImageKit private key가 설정되지 않았습니다.');
    }
    const token = crypto.randomUUID();
    const expire = Math.floor(Date.now() / 1000) + 600; // 10분
    const signature = crypto
      .createHmac('sha1', IMAGEKIT_PRIVATE_KEY)
      .update(token + expire)
      .digest('hex');
    return ok(res, {
      token,
      expire,
      signature,
      publicKey: IMAGEKIT_PUBLIC_KEY,
      urlEndpoint: IMAGEKIT_URL_ENDPOINT,
    });
  } catch (err) {
    console.error('[GET /api/imagekit-auth]', err);
    return fail(res, 500, 'ImageKit 인증 파라미터 생성 실패');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6.3. API routes — 관리자 상품 등록
// ──────────────────────────────────────────────────────────────────────────
// Body: {
//   id (slug, 'product-7' 같은 형태),
//   name, description, price, stock,
//   artist_id (int), category_id (int),
//   thumbnail_url (ImageKit URL),
//   specs (object, 선택)
// }
const SLUG_RE = /^[a-z0-9][a-z0-9\-]{1,49}$/;

// 한글/공백 포함된 이름을 URL-safe slug로 — 한글은 보존 못 하므로 timestamp+해시 fallback
function makeSlug(name, prefix) {
  const ascii = String(name).toLowerCase()
    .replace(/[^\x00-\x7f]/g, '')   // 비ASCII 제거
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const suffix = Date.now().toString(36).slice(-6);
  const base = ascii || prefix;
  return `${base}-${suffix}`.slice(0, 50);
}

// 작가 resolve — id가 있으면 그것, 없으면 name으로 새로 생성
async function resolveArtist(client, b) {
  const id = Number(b.artist_id);
  if (Number.isInteger(id) && id > 0) {
    const r = await client.query('SELECT id FROM artists WHERE id = $1', [id]);
    if (r.rowCount === 0) throw Object.assign(new Error('선택한 작가가 없습니다.'), { status: 400 });
    return id;
  }
  const name = String(b.artist_name || '').trim();
  if (!name)            throw Object.assign(new Error('작가를 선택하거나 입력해주세요.'), { status: 400 });
  if (name.length > 100) throw Object.assign(new Error('작가명이 너무 깁니다.'), { status: 400 });

  // 동일 이름이 이미 있으면 재사용
  const exist = await client.query('SELECT id FROM artists WHERE name = $1', [name]);
  if (exist.rowCount > 0) return exist.rows[0].id;

  const region = String(b.artist_region || '').trim().slice(0, 50) || null;
  const slug = makeSlug(name, 'artist');
  const ins = await client.query(
    `INSERT INTO artists (slug, name, region) VALUES ($1, $2, $3) RETURNING id`,
    [slug, name, region]
  );
  return ins.rows[0].id;
}

// 카테고리 resolve — id가 있으면 그것, 없으면 name으로 새로 생성
async function resolveCategory(client, b) {
  const id = Number(b.category_id);
  if (Number.isInteger(id) && id > 0) {
    const r = await client.query('SELECT id FROM categories WHERE id = $1', [id]);
    if (r.rowCount === 0) throw Object.assign(new Error('선택한 카테고리가 없습니다.'), { status: 400 });
    return id;
  }
  const name = String(b.category_name || '').trim();
  if (!name)           throw Object.assign(new Error('카테고리를 선택하거나 입력해주세요.'), { status: 400 });
  if (name.length > 50) throw Object.assign(new Error('카테고리명이 너무 깁니다.'), { status: 400 });

  const exist = await client.query('SELECT id FROM categories WHERE name = $1', [name]);
  if (exist.rowCount > 0) return exist.rows[0].id;

  const slug = makeSlug(name, 'category');
  const ins = await client.query(
    `INSERT INTO categories (slug, name, display_order, is_active)
     VALUES ($1, $2, COALESCE((SELECT MAX(display_order) FROM categories), 0) + 10, TRUE)
     RETURNING id`,
    [slug, name]
  );
  return ins.rows[0].id;
}

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id            = String(b.id || '').trim().toLowerCase();
  const name          = String(b.name || '').trim();
  const description   = String(b.description || '').trim();
  const price         = Number(b.price);
  const stock         = Number(b.stock);
  const thumbnailUrl  = String(b.thumbnail_url || '').trim();
  const specs         = (b.specs && typeof b.specs === 'object') ? b.specs : {};

  if (!SLUG_RE.test(id))            return fail(res, 400, '상품 ID는 영문/숫자/하이픈(2~50자)이어야 합니다.');
  if (!name || name.length > 200)   return fail(res, 400, '상품명을 입력해주세요.');
  if (!description)                 return fail(res, 400, '설명을 입력해주세요.');
  if (!Number.isInteger(price) || price < 0)
                                    return fail(res, 400, '가격은 0 이상 정수여야 합니다.');
  if (!Number.isInteger(stock) || stock < 0)
                                    return fail(res, 400, '재고는 0 이상 정수여야 합니다.');
  if (!thumbnailUrl || !/^https?:\/\//i.test(thumbnailUrl))
                                    return fail(res, 400, '대표 이미지 URL이 올바르지 않습니다.');

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query('SELECT 1 FROM products WHERE id = $1', [id]);
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return fail(res, 409, '이미 존재하는 상품 ID입니다.');
    }

    const artistId   = await resolveArtist(client, b);
    const categoryId = await resolveCategory(client, b);

    const ins = await client.query(
      `INSERT INTO products
         (id, artist_id, category_id, name, description, price_krw,
          thumbnail_url, specs, stock, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, TRUE)
       RETURNING id`,
      [id, artistId, categoryId, name, description, price,
       thumbnailUrl, JSON.stringify(specs), stock]
    );
    await client.query(
      `INSERT INTO product_images (product_id, url, alt, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [id, thumbnailUrl, name]
    );

    await client.query('COMMIT');
    return ok(res, { id: ins.rows[0].id }, 201);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/admin/products]', err);
    if (err && err.status) return fail(res, err.status, err.message);
    if (err && err.code === '23503') {
      return fail(res, 400, '선택한 작가/카테고리가 존재하지 않습니다.');
    }
    return fail(res, 500, '상품 등록 처리 중 오류가 발생했습니다.');
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6.4. API routes — /api/orders (주문 생성 / 본인 주문 조회)
// ──────────────────────────────────────────────────────────────────────────
// 결제 위젯에 넘길 orderId/amount를 서버가 결정해야 위변조를 막을 수 있다.
// 흐름:
//   1) 클라이언트가 장바구니 + 배송지 정보로 POST /api/orders → pending 주문 생성
//   2) 응답의 order_number/total_krw로 Toss 위젯 호출
//   3) Toss redirect 후 POST /api/payments/confirm — 서버가 DB 금액과 비교 후 승인

function makeOrderNumber(seq, year) {
  return `DAL-${year}-${String(seq).padStart(6, '0')}`;
}

app.post('/api/orders', requireAuth, async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) return fail(res, 400, '주문 상품이 비어있습니다.');

  const shipping = b.shipping || {};
  const recipient = String(shipping.recipient || '').trim();
  const phone     = String(shipping.phone     || '').trim();
  const postcode  = String(shipping.postcode  || '').trim();
  const address1  = String(shipping.address1  || '').trim();
  const address2  = String(shipping.address2  || '').trim() || null;
  const memo      = String(shipping.memo      || '').trim() || null;

  if (!recipient || recipient.length > 50)  return fail(res, 400, '받는 분 이름을 입력해주세요.');
  if (!phone     || phone.length > 20)      return fail(res, 400, '연락처를 입력해주세요.');
  if (!postcode  || postcode.length > 10)   return fail(res, 400, '우편번호를 입력해주세요.');
  if (!address1  || address1.length > 200)  return fail(res, 400, '주소를 입력해주세요.');

  // 입력 검증 — 각 항목 {id: string, qty: int>0}
  const cleaned = [];
  for (const it of items) {
    const pid = String(it?.id || '').trim();
    const qty = Number(it?.qty);
    if (!pid)                          return fail(res, 400, '상품 ID가 누락되었습니다.');
    if (!Number.isInteger(qty) || qty <= 0)
                                       return fail(res, 400, '수량이 올바르지 않습니다.');
    cleaned.push({ id: pid, qty });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 상품 + 작가명 한 번에 조회 (스냅샷 + 가격 결정용)
    const ids = cleaned.map(c => c.id);
    const { rows: prodRows } = await client.query(
      `SELECT p.id, p.name, p.thumbnail_url, p.price_krw, p.stock,
              p.is_active, a.name AS artist_name
         FROM products p
         JOIN artists a ON a.id = p.artist_id
        WHERE p.id = ANY($1::text[])`,
      [ids]
    );
    const byId = new Map(prodRows.map(r => [r.id, r]));
    for (const c of cleaned) {
      const p = byId.get(c.id);
      if (!p)             { await client.query('ROLLBACK'); return fail(res, 400, `존재하지 않는 상품: ${c.id}`); }
      if (!p.is_active)   { await client.query('ROLLBACK'); return fail(res, 400, `판매 중지된 상품입니다: ${p.name}`); }
      if (p.stock < c.qty){ await client.query('ROLLBACK'); return fail(res, 400, `재고 부족: ${p.name}`); }
    }

    // 금액 계산 — 서버가 결정 (클라이언트 가격 무시)
    let subtotal = 0;
    for (const c of cleaned) {
      const p = byId.get(c.id);
      subtotal += p.price_krw * c.qty;
    }
    const shippingFee = subtotal >= 50000 ? 0 : 3000;
    const total       = subtotal + shippingFee;

    // 주문번호
    const { rows: seqRows } = await client.query(`SELECT nextval('orders_seq') AS seq`);
    const year = new Date().getFullYear();
    const orderNumber = makeOrderNumber(seqRows[0].seq, year);

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders
         (order_number, user_id, status, subtotal_krw, shipping_krw, discount_krw, total_krw,
          shipping_recipient, shipping_phone, shipping_postcode,
          shipping_address1, shipping_address2, shipping_memo)
       VALUES ($1, $2, 'pending', $3, $4, 0, $5,
               $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [orderNumber, req.user.id, subtotal, shippingFee, total,
       recipient, phone, postcode, address1, address2, memo]
    );
    const orderUuid = orderRows[0].id;

    for (const c of cleaned) {
      const p = byId.get(c.id);
      const lineTotal = p.price_krw * c.qty;
      await client.query(
        `INSERT INTO order_items
           (order_id, product_id,
            product_name_snapshot, product_image_snapshot, artist_name_snapshot,
            unit_price_krw, qty, line_total_krw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderUuid, p.id, p.name, p.thumbnail_url, p.artist_name,
         p.price_krw, c.qty, lineTotal]
      );
    }

    await client.query('COMMIT');
    return ok(res, {
      orderNumber,
      subtotal,
      shipping: shippingFee,
      total,
    }, 201);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/orders]', err);
    return fail(res, 500, '주문 생성 처리 중 오류가 발생했습니다.');
  } finally {
    client.release();
  }
});

// 본인의 pending 주문 삭제 (결제 대기 상태만 가능)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.delete('/api/me/orders/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return fail(res, 400, '잘못된 주문 ID입니다.');

    const pool = getPool();
    // 소유자 + status 검사를 한 쿼리로 — 다른 상태나 타인 주문은 삭제 불가
    const { rowCount } = await pool.query(
      `DELETE FROM orders
        WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, req.user.id]
    );
    if (rowCount === 0) {
      // 존재하지 않거나, 본인 것이 아니거나, pending이 아닌 경우 모두 같은 메시지
      return fail(res, 404, '삭제할 수 있는 주문이 아닙니다.');
    }
    return ok(res, { deleted: id });
  } catch (err) {
    console.error('[DELETE /api/me/orders/:id]', err);
    return fail(res, 500, '주문 삭제 처리 중 오류가 발생했습니다.');
  }
});

// 본인 주문 목록 (마이페이지용)
app.get('/api/me/orders', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { rows: orders } = await pool.query(
      `SELECT id, order_number, status,
              subtotal_krw, shipping_krw, discount_krw, total_krw,
              shipping_recipient, shipping_phone, shipping_postcode,
              shipping_address1, shipping_address2,
              payment_method, payment_reference,
              created_at, paid_at
         FROM orders
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    if (orders.length === 0) return ok(res, []);

    const ids = orders.map(o => o.id);
    const { rows: itemRows } = await pool.query(
      `SELECT order_id, product_id,
              product_name_snapshot AS name,
              product_image_snapshot AS image,
              artist_name_snapshot AS artist,
              unit_price_krw AS unit_price, qty, line_total_krw AS line_total
         FROM order_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY id`,
      [ids]
    );
    const byOrder = new Map();
    for (const it of itemRows) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
    const shaped = orders.map(o => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      subtotal: o.subtotal_krw,
      shipping: o.shipping_krw,
      discount: o.discount_krw,
      total: o.total_krw,
      recipient: o.shipping_recipient,
      phone: o.shipping_phone,
      address: `(${o.shipping_postcode}) ${o.shipping_address1}${o.shipping_address2 ? ' ' + o.shipping_address2 : ''}`,
      paymentMethod: o.payment_method,
      paymentReference: o.payment_reference,
      createdAt: o.created_at,
      paidAt: o.paid_at,
      items: byOrder.get(o.id) || [],
    }));
    return ok(res, shaped);
  } catch (err) {
    console.error('[GET /api/me/orders]', err);
    return fail(res, 500, '주문 내역을 불러오지 못했습니다.');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6.5. API routes — /api/payments
// ──────────────────────────────────────────────────────────────────────────
// 토스페이먼츠 결제 승인 (Confirm)
//
// 흐름:
//   1) 클라이언트가 결제 위젯에서 결제 요청 (TossPayments.requestPayment)
//   2) 사용자가 결제 완료 → successUrl로 리다이렉트되며 paymentKey/orderId/amount 전달
//   3) 클라이언트가 이 엔드포인트로 위 3개 값 전달
//   4) 서버가 TossPayments API 호출 → 실제 결제 승인
//
// 보안 주의:
//   - TOSS_SECRET_KEY는 절대 클라이언트로 노출 금지 (.env에서만 사용)
//   - 운영 환경에서는 amount를 DB의 주문 금액과 비교해서 위변조 검증 필요
//     (현재 데모는 orders 테이블이 없어 클라이언트 amount를 신뢰하지만,
//      실제 운영 시 반드시 서버 저장 금액과 비교할 것)
app.post('/api/payments/confirm', async (req, res) => {
  try {
    if (!TOSS_SECRET_KEY) {
      return fail(res, 500, '결제 시크릿 키가 설정되지 않았습니다.');
    }
    const { paymentKey, orderId, amount } = req.body || {};
    if (typeof paymentKey !== 'string' || !paymentKey) {
      return fail(res, 400, 'paymentKey가 누락되었습니다.');
    }
    if (typeof orderId !== 'string' || !orderId) {
      return fail(res, 400, 'orderId가 누락되었습니다.');
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return fail(res, 400, 'amount가 올바르지 않습니다.');
    }

    const pool = getPool();

    // 1) DB에서 주문 조회 — orderId === order_number
    const { rows } = await pool.query(
      `SELECT id, status, total_krw FROM orders WHERE order_number = $1`,
      [orderId]
    );
    const order = rows[0];
    if (!order)                       return fail(res, 404, '주문을 찾을 수 없습니다.');
    if (order.total_krw !== Math.trunc(numericAmount))
                                      return fail(res, 400, '결제 금액이 일치하지 않습니다.');
    if (order.status === 'paid')      return fail(res, 409, '이미 결제 완료된 주문입니다.');
    if (order.status !== 'pending')   return fail(res, 400, '결제 가능한 상태가 아닙니다.');

    // 2) Toss API 호출
    const encodedKey = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    const tossRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encodedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: numericAmount }),
    });
    const data = await tossRes.json().catch(() => ({}));
    if (!tossRes.ok) {
      console.error('[POST /api/payments/confirm] toss error:', data);
      return res.status(tossRes.status).json({
        success: false,
        message: data?.message || '결제 승인에 실패했습니다.',
        code: data?.code || 'PAYMENT_CONFIRM_FAILED',
      });
    }

    // 3) DB 상태 업데이트 (재고 차감 포함, 트랜잭션)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE orders
            SET status = 'paid',
                payment_method = $2,
                payment_reference = $3,
                paid_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [order.id, data.method || null, paymentKey]
      );
      // 재고 차감
      await client.query(
        `UPDATE products p
            SET stock = p.stock - oi.qty
           FROM order_items oi
          WHERE oi.order_id = $1
            AND oi.product_id = p.id`,
        [order.id]
      );
      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[POST /api/payments/confirm] db update failed:', dbErr);
      // Toss는 이미 승인된 상태이므로 운영 시 알림/재시도 큐에 적재해야 한다.
    } finally {
      client.release();
    }

    return ok(res, {
      orderId: data.orderId,
      orderName: data.orderName,
      method: data.method,
      totalAmount: data.totalAmount,
      status: data.status,
      approvedAt: data.approvedAt,
      receipt: data.receipt,
    });
  } catch (err) {
    console.error('[POST /api/payments/confirm]', err);
    return fail(res, 500, '결제 승인 처리 중 오류가 발생했습니다.');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 7. Health check
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let dbStatus = 'error';
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    dbStatus = 'ok';
  } catch (err) {
    console.error('[GET /api/health] db ping failed:', err.message);
  }
  return ok(res, { db: dbStatus, uptime: process.uptime() });
});

// ──────────────────────────────────────────────────────────────────────────
// 8. SPA fallback (avoid Express 5 path-to-regexp wildcard quirks)
// ──────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ──────────────────────────────────────────────────────────────────────────
// 9. Last-resort error handler
// ──────────────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// ──────────────────────────────────────────────────────────────────────────
// 10. Dual mode — local listen vs serverless export
// ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dalhangari server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
