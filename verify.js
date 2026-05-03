const { chromium } = require('C:/Users/kikim/Downloads/AFM-WEEKEND-6/image-upload-test/node_modules/playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const dir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => { console.log('  [pageerror]', e.message); errors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error') { console.log('  [console.error]', m.text()); errors.push(m.text()); } });

  console.log('[1] Home — products via API');
  await page.goto('http://localhost:4000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  // Wait for at least one product image
  await page.waitForFunction(
    () => document.querySelectorAll('a.product-card').length === 6,
    { timeout: 8000 }
  );
  await page.screenshot({ path: path.join(dir, 'api-01-home.png'), fullPage: true });
  console.log('   OK 6 products rendered from /api/products');

  console.log('[2] Open signup modal');
  // 데스크톱: 우측 상단 "로그인" 버튼
  await page.locator('button[aria-label="로그인"]').first().click();
  await page.waitForSelector('text=Welcome back');
  // 회원가입 토글
  await page.locator('button:has-text("회원가입")').first().click();
  await page.waitForSelector('text=Join Dalhangari');
  await page.screenshot({ path: path.join(dir, 'api-02-signup-modal.png'), fullPage: true });

  console.log('[3] Submit signup with random email');
  const email = `qa+${Date.now()}@dalhangari.kr`;
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'secret123');
  await page.fill('input[autocomplete="name"]', '큐에이');
  await page.locator('button[type="submit"]').click();
  // Modal should close and user-menu button (no aria-label="로그인") appears
  await page.waitForFunction(() => {
    return !document.querySelector('[role="dialog"][aria-modal="true"]');
  }, { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, 'api-03-after-signup.png'), fullPage: true });
  const headerHtml = await page.locator('header').innerText();
  console.log('   header includes user name?', headerHtml.includes('큐에이'));

  console.log('[4] Reload page — token persists?');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(dir, 'api-04-reload-still-logged-in.png'), fullPage: true });

  console.log('[5] Logout');
  await page.locator('button[aria-label$="메뉴"]:visible').first().click();
  await page.waitForTimeout(200);
  await page.locator('button:has-text("로그아웃")').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, 'api-05-after-logout.png'), fullPage: true });

  console.log('[6] Login again');
  await page.locator('button[aria-label="로그인"]').first().click();
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'secret123');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, 'api-06-logged-in.png'), fullPage: true });

  console.log('[7] Product detail loads via API');
  await page.goto('http://localhost:4000/#/product/product-2', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(dir, 'api-07-product-detail.png'), fullPage: true });

  console.log('[8] Wrong password rejected');
  await page.goto('http://localhost:4000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  // Need to logout first
  await page.locator('button[aria-label$="메뉴"]:visible').first().click();
  await page.waitForTimeout(200);
  await page.locator('button:has-text("로그아웃")').click();
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="로그인"]').first().click();
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'wrongpass');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(800);
  const errorVisible = await page.locator('text=올바르지 않').count();
  console.log('   wrong-password error visible:', errorVisible > 0);
  await page.screenshot({ path: path.join(dir, 'api-08-bad-password.png'), fullPage: true });

  await browser.close();
  if (errors.length) {
    console.log('\nPage errors detected:', errors.length);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
