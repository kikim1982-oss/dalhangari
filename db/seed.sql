-- ============================================================================
-- Dalhangari — Seed data (현재 React PRODUCTS 배열을 그대로 옮김)
-- ============================================================================

-- ──────────── artists ────────────
INSERT INTO artists (slug, name, region, bio) VALUES
  ('idoyeon-doband',  '이도연 도방',  '경기 이천',
   '맑은 백자의 결을 따라 단정한 그릇을 빚는 작가의 작업실.'),
  ('heuk-gwa-gyeol',  '흙과 결',      '경남 산청',
   '거친 흙맛과 결을 살리는 분청사기 전문 공방.'),
  ('goyo-dagu',       '고요 다구',    '서울',
   '차의 시간을 위한 청자 다구를 빚는 1인 공방.'),
  ('geomeun-gama',    '검은 가마',    '강원 강릉',
   '무광 검정 유약을 깊이 있게 다루는 작가.'),
  ('onggi-maeul',     '옹기마을',     '울산',
   '대를 이어 옹기를 빚는 가마.'),
  ('sancheong-tobang','산청 토방',    '경남 산청',
   '거친 흙의 자연스러움을 담는 다완 작가.');

-- ──────────── categories ────────────
INSERT INTO categories (slug, name, display_order) VALUES
  ('rice-bowl', '밥그릇',  10),
  ('plate',     '접시',    20),
  ('tea-cup',   '찻잔',    30),
  ('pasta-bowl','면기/볼', 40),
  ('jar',       '보관용',  50),
  ('tea-bowl',  '다완',    60);

-- ──────────── products ────────────
INSERT INTO products
  (id, artist_id, category_id, name, description, price_krw, thumbnail_url, specs, stock)
VALUES
  ('product-1',
   (SELECT id FROM artists    WHERE slug = 'idoyeon-doband'),
   (SELECT id FROM categories WHERE slug = 'rice-bowl'),
   '백자 막사발',
   '단정한 곡선과 깊은 백색이 어우러진 막사발입니다. 손에 쥐었을 때의 따뜻한 무게감이 매일의 식사를 한층 정성스럽게 만들어 줍니다. 한 점 한 점 손으로 빚어 미세한 결이 살아 있습니다.',
   38000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-1_gvG_qq5SB.jpg',
   '{"size":"지름 12cm × 높이 7cm","material":"백자토, 환원소성","care":"식기세척기 사용 가능, 전자레인지 가능"}'::jsonb,
   24),

  ('product-2',
   (SELECT id FROM artists    WHERE slug = 'heuk-gwa-gyeol'),
   (SELECT id FROM categories WHERE slug = 'plate'),
   '분청 라운드 접시',
   '분청사기 특유의 흙맛과 거친 결이 살아 있는 라운드 접시. 갈색과 회백색이 자연스럽게 섞여 어떤 음식과도 잘 어울립니다. 무광 마감으로 차분한 식탁을 완성합니다.',
   52000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-2_NAK0GfxOQC.jpg',
   '{"size":"지름 22cm × 높이 2.5cm","material":"분청토, 산화소성","care":"부드러운 스펀지로 손세척 권장"}'::jsonb,
   18),

  ('product-3',
   (SELECT id FROM artists    WHERE slug = 'goyo-dagu'),
   (SELECT id FROM categories WHERE slug = 'tea-cup'),
   '청자 손잡이없는 찻잔',
   '맑고 은은한 청자색이 차의 빛깔을 더욱 깊게 비춰 줍니다. 손잡이 없는 단순한 형태로 두 손에 감기는 따뜻함이 일품입니다. 차 한 잔의 시간을 위해 정성껏 빚어졌습니다.',
   28000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-3_1ZdfD3aOH.jpg',
   '{"size":"지름 7cm × 높이 6cm, 약 120ml","material":"청자토, 환원소성","care":"손세척 권장, 급격한 온도 변화 주의"}'::jsonb,
   30),

  ('product-4',
   (SELECT id FROM artists    WHERE slug = 'geomeun-gama'),
   (SELECT id FROM categories WHERE slug = 'pasta-bowl'),
   '매트블랙 파스타볼',
   '깊고 넓은 형태에 무광 검정이 우아하게 떨어지는 파스타볼. 거친 도자기 질감이 한 끼의 무드를 한층 끌어올립니다. 면 요리는 물론 샐러드 그릇으로도 잘 어울립니다.',
   64000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-4_Fq6K0Dudlx.jpg',
   '{"size":"지름 24cm × 높이 6cm","material":"흑유, 환원소성","care":"손세척 권장"}'::jsonb,
   12),

  ('product-5',
   (SELECT id FROM artists    WHERE slug = 'onggi-maeul'),
   (SELECT id FROM categories WHERE slug = 'jar'),
   '옹기 양념 항아리',
   '옹기 특유의 숨쉬는 흙으로 빚어 발효와 보관에 적합한 미니 항아리. 깊은 갈색 유약이 시간이 흐를수록 더 깊어집니다. 뚜껑이 함께 제공됩니다.',
   45000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-5_xmBO763j3.jpg',
   '{"size":"지름 14cm × 높이 16cm, 약 1.2L","material":"옹기토","care":"첫 사용 전 끓는 물로 한 번 헹궈 주세요"}'::jsonb,
   20),

  ('product-6',
   (SELECT id FROM artists    WHERE slug = 'sancheong-tobang'),
   (SELECT id FROM categories WHERE slug = 'tea-bowl'),
   '다완',
   '거친 흙 결과 자연스러운 비대칭이 살아 있는 다완. 두 손에 감기는 형태로 차의 온기를 오래 머금습니다. 한 점 한 점 모두 다른 표정을 지닙니다.',
   89000,
   'https://ik.imagekit.io/kikim1982/dalhangari/products/product-6_EzYmp40VUc.jpg',
   '{"size":"지름 13cm × 높이 8cm","material":"산청 흙, 장작가마 환원소성","care":"손세척, 직사광선 피해 보관"}'::jsonb,
   8);

-- ──────────── product_images (대표 이미지를 첫 번째로) ────────────
INSERT INTO product_images (product_id, url, alt, sort_order)
SELECT id, thumbnail_url, name, 0 FROM products;
