-- ============================================================================
-- Dalhangari (달항아리) — Korean ceramics e-commerce schema
-- Target: PostgreSQL 14+
-- ============================================================================
--
-- 디자인 원칙:
--   1. 현재 React UI의 데이터 모양(PRODUCTS 배열, cart [{id, qty}],
--      wishlist [productId])을 그대로 매핑할 수 있게 한다.
--   2. 카트/위시리스트는 클라이언트 localStorage에서 관리한다.
--   3. 주문은 작성 시점 정보를 "스냅샷"으로 보존한다. (가격·이름이
--      나중에 바뀌어도 영수증은 변하지 않게.)
--   4. 카테고리·작가(공방)는 자유 문자열 대신 별도 테이블로 정규화.
-- ============================================================================

-- gen_random_uuid() 사용을 위한 익스텐션 (PG 13~16). PG 17+에서는 무시됨.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. artists  — 작가 / 공방
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE artists (
  id          SERIAL       PRIMARY KEY,
  slug        VARCHAR(50)  NOT NULL UNIQUE,           -- 'idoyeon-doband'
  name        VARCHAR(100) NOT NULL,                  -- '이도연 도방'
  bio         TEXT,                                   -- 작가 소개
  region      VARCHAR(50),                            -- '경기 이천', '경남 산청' 등
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  artists      IS '작가/공방 마스터';
COMMENT ON COLUMN artists.slug IS 'URL용 식별자, 한글명을 영문으로';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. categories  — 그릇 카테고리 (밥그릇, 접시, 찻잔, …)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id             SERIAL      PRIMARY KEY,
  slug           VARCHAR(50) NOT NULL UNIQUE,         -- 'rice-bowl'
  name           VARCHAR(50) NOT NULL,                -- '밥그릇'
  display_order  INT         NOT NULL DEFAULT 0,      -- UI 노출 순서
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE categories IS '제품 카테고리. 현재 PRODUCTS[].category 컬럼 정규화 대상';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. products  — 핵심 상품 테이블
-- ──────────────────────────────────────────────────────────────────────────
-- 현재 React 코드에서 product.id가 'product-1' 형태로 URL 경로
-- (`/#/product/product-1`)에 그대로 들어가므로, PK 자체를 slug-style
-- VARCHAR로 둔다. 새 ID 체계가 필요하면 별도 BIGSERIAL을 추가하고
-- 이 컬럼은 'slug'로 리네이밍하면 된다.
CREATE TABLE products (
  id              VARCHAR(50)  PRIMARY KEY,           -- 'product-1', 'baekja-maksabal'
  artist_id       INT          NOT NULL REFERENCES artists(id)    ON DELETE RESTRICT,
  category_id     INT          NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name            VARCHAR(200) NOT NULL,
  description     TEXT         NOT NULL,
  price_krw       INT          NOT NULL CHECK (price_krw >= 0),   -- 원 단위 정수
  thumbnail_url   TEXT         NOT NULL,                          -- 카드/리스트용 대표 이미지
  specs           JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- {size, material, care, ...}
  stock           INT          NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,             -- 판매중 여부
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_active   ON products(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_products_artist   ON products(artist_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_price    ON products(price_krw);

COMMENT ON COLUMN products.specs IS
  '상품 속성 (사이즈/소재/관리법 등). 현재 UI는 size, material, care 키를 사용';
COMMENT ON COLUMN products.price_krw IS
  '판매가, 단위 원(KRW). 부가세 포함, 정수만 허용';

-- ──────────────────────────────────────────────────────────────────────────
-- 4. product_images  — 상세 페이지 추가 이미지 (현재 UI는 1장만 사용)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE product_images (
  id          SERIAL       PRIMARY KEY,
  product_id  VARCHAR(50)  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT         NOT NULL,
  alt         VARCHAR(200),
  sort_order  INT          NOT NULL DEFAULT 0
);

CREATE INDEX idx_product_images_product ON product_images(product_id, sort_order);

-- ──────────────────────────────────────────────────────────────────────────
-- 5. users  — 회원
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  name           VARCHAR(100),
  phone          VARCHAR(20),
  password_hash  TEXT         NOT NULL,               -- bcrypt/argon2
  marketing_opt  BOOLEAN      NOT NULL DEFAULT FALSE, -- 마케팅 수신 동의
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ──────────────────────────────────────────────────────────────────────────
-- (참고) 카트/위시리스트는 클라이언트 localStorage에서 관리.
-- 멀티 디바이스 동기화가 필요해지면 cart_items / wishlist_items 테이블을
-- 추가하고, 로그인 시 클라이언트 상태를 UPSERT 머지하면 된다.
-- ──────────────────────────────────────────────────────────────────────────

-- ──────────────────────────────────────────────────────────────────────────
-- 6. orders  — 주문 헤더
-- ──────────────────────────────────────────────────────────────────────────
-- 비회원 주문 가능 (user_id NULL 허용).
-- 배송지는 매번 변경 가능하므로 주문 시점 값을 그대로 박아 둔다.
-- 5만원 이상 무료배송 로직은 애플리케이션이 계산하여 shipping_krw에 저장.
-- 사람이 읽을 수 있는 주문 번호 'DAL-2026-000123' 생성용 시퀀스
CREATE SEQUENCE orders_seq START 1;

CREATE TYPE order_status AS ENUM (
  'pending',     -- 결제 대기
  'paid',        -- 결제 완료
  'preparing',   -- 상품 준비중
  'shipping',    -- 배송중
  'delivered',   -- 배송 완료
  'cancelled',   -- 취소
  'refunded'     -- 환불
);

CREATE TABLE orders (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        VARCHAR(20)   NOT NULL UNIQUE,            -- 'DAL-2026-000123'
  user_id             UUID          REFERENCES users(id) ON DELETE SET NULL,
  status              order_status  NOT NULL DEFAULT 'pending',

  -- 금액 (모두 원 단위 정수, 결제 시점 스냅샷)
  subtotal_krw        INT           NOT NULL CHECK (subtotal_krw >= 0),
  shipping_krw        INT           NOT NULL CHECK (shipping_krw >= 0),
  discount_krw        INT           NOT NULL DEFAULT 0 CHECK (discount_krw >= 0),
  total_krw           INT           NOT NULL CHECK (total_krw >= 0),

  -- 배송지 스냅샷 (계정 삭제/변경과 무관하게 보존)
  shipping_recipient  VARCHAR(50)   NOT NULL,
  shipping_phone      VARCHAR(20)   NOT NULL,
  shipping_postcode   VARCHAR(10)   NOT NULL,
  shipping_address1   VARCHAR(200)  NOT NULL,
  shipping_address2   VARCHAR(200),
  shipping_memo       VARCHAR(200),

  -- 결제 메타 (결제 게이트웨이 연동 시 사용)
  payment_method      VARCHAR(30),                              -- 'card', 'kakaopay', ...
  payment_reference   VARCHAR(100),                             -- PG사 거래 ID

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user        ON orders(user_id);
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_created_at  ON orders(created_at DESC);

-- ──────────────────────────────────────────────────────────────────────────
-- 7. order_items  — 주문 상품 (스냅샷 보존)
-- ──────────────────────────────────────────────────────────────────────────
-- product_id로 현재 상품을 참조하지만, 이름·이미지·가격은 주문 시점
-- 값을 별도 컬럼에 저장한다. (제품 정보가 변해도 주문 내역은 불변)
CREATE TABLE order_items (
  id                       BIGSERIAL    PRIMARY KEY,
  order_id                 UUID         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id               VARCHAR(50)  NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  product_name_snapshot    VARCHAR(200) NOT NULL,
  product_image_snapshot   TEXT         NOT NULL,
  artist_name_snapshot     VARCHAR(100) NOT NULL,

  unit_price_krw           INT          NOT NULL CHECK (unit_price_krw >= 0),
  qty                      INT          NOT NULL CHECK (qty > 0),
  line_total_krw           INT          NOT NULL CHECK (line_total_krw >= 0)
);

CREATE INDEX idx_order_items_order   ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at 자동 갱신 트리거
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- 편의 뷰: 클라이언트가 기대하는 형태로 한 번에 조회
-- ──────────────────────────────────────────────────────────────────────────
-- React PRODUCTS 배열과 동일한 모양:
--   { id, name, artist, category, price, image, description, specs }
CREATE VIEW v_product_card AS
SELECT
  p.id,
  p.name,
  a.name           AS artist,
  c.name           AS category,
  p.price_krw      AS price,
  p.thumbnail_url  AS image,
  p.description,
  p.specs,
  p.stock,
  p.is_active
FROM products p
JOIN artists    a ON a.id = p.artist_id
JOIN categories c ON c.id = p.category_id;
