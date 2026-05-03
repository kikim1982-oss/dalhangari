-- ============================================================================
-- 자주 쓰는 쿼리 모음 (UI 동작별)
-- ============================================================================

-- ─── 홈: 활성 상품 전체 (현재 React PRODUCTS 배열 모양) ───
SELECT *
FROM v_product_card
WHERE is_active = TRUE
ORDER BY id;

-- ─── 카테고리 필터링 (예: 찻잔만) ───
SELECT *
FROM v_product_card
WHERE is_active = TRUE
  AND category = '찻잔';

-- ─── 상품 상세 (1건 + 추가 이미지) ───
SELECT
  p.*,
  a.name   AS artist_name,
  a.bio    AS artist_bio,
  a.region AS artist_region,
  c.name   AS category_name,
  COALESCE(
    (SELECT json_agg(json_build_object('url', pi.url, 'alt', pi.alt) ORDER BY pi.sort_order)
       FROM product_images pi WHERE pi.product_id = p.id),
    '[]'::json
  ) AS images
FROM products p
JOIN artists    a ON a.id = p.artist_id
JOIN categories c ON c.id = p.category_id
WHERE p.id = $1;

-- ─── 함께 보면 좋은 그릇 (같은 카테고리 또는 같은 작가, 본인 제외) ───
SELECT *
FROM v_product_card
WHERE id <> $1
  AND is_active = TRUE
  AND (
    category = (SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = $1)
    OR artist  = (SELECT a.name FROM products p JOIN artists    a ON a.id = p.artist_id    WHERE p.id = $1)
  )
ORDER BY RANDOM()
LIMIT 3;

-- ============================================================================
-- (참고) 장바구니 / 위시리스트는 클라이언트 localStorage에서 관리한다.
-- 서버 동기화가 필요해지면 cart_items / wishlist_items 테이블을 추가하고
-- UPSERT 쿼리로 머지하면 된다.
-- ============================================================================

-- ============================================================================
-- 주문
-- ============================================================================

-- ─── 주문 생성 (트랜잭션으로 감싸서 사용) ───
-- 1) order_number 생성
SELECT 'DAL-' || to_char(NOW(), 'YYYY') || '-' ||
       lpad(nextval('orders_seq')::text, 6, '0') AS order_number;

-- 2) orders insert
INSERT INTO orders (
  order_number, user_id, status,
  subtotal_krw, shipping_krw, discount_krw, total_krw,
  shipping_recipient, shipping_phone, shipping_postcode,
  shipping_address1, shipping_address2, shipping_memo,
  payment_method
) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id;

-- 3) order_items insert (클라이언트가 보낸 items 배열을 스냅샷으로 복사)
--    $2 = jsonb 배열 [{"id":"product-1","qty":2}, ...]
INSERT INTO order_items (
  order_id, product_id,
  product_name_snapshot, product_image_snapshot, artist_name_snapshot,
  unit_price_krw, qty, line_total_krw
)
SELECT
  $1::uuid,
  p.id,
  p.name,
  p.thumbnail_url,
  a.name,
  p.price_krw,
  x.qty,
  p.price_krw * x.qty
FROM jsonb_to_recordset($2::jsonb) AS x(id VARCHAR(50), qty INT)
JOIN products p ON p.id = x.id
JOIN artists  a ON a.id = p.artist_id;

-- 4) 재고 차감 (결제 승인 시점, order_items 기준)
UPDATE products p
   SET stock = p.stock - oi.qty
  FROM order_items oi
 WHERE oi.order_id = $1 AND oi.product_id = p.id;

-- ─── 사용자 주문 내역 ───
SELECT
  o.id,
  o.order_number,
  o.status,
  o.total_krw,
  o.created_at,
  json_agg(
    json_build_object(
      'product_id',  oi.product_id,
      'name',        oi.product_name_snapshot,
      'image',       oi.product_image_snapshot,
      'artist',      oi.artist_name_snapshot,
      'unit_price',  oi.unit_price_krw,
      'qty',         oi.qty
    )
  ) AS items
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.user_id = $1
GROUP BY o.id
ORDER BY o.created_at DESC;
