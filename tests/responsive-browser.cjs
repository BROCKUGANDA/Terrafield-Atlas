const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('../tools/browser-check/node_modules/playwright');
const base = process.env.TEST_URL || 'http://localhost:3033';

(async () => {
  for (const [name, engine, options] of [['Edge', chromium, { channel: 'msedge' }], ['Firefox', firefox, {}], ['WebKit', webkit, {}]]) {
    const browser = await engine.launch({ headless: true, ...options });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Understood', exact: true }).click();
      for (const width of [320, 375, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: landing overflows at ${width}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const sessionResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/session') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Open console navigation' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Geospatial Explorer', exact: true }).click();
      await page.waitForFunction(() => location.hash.includes('view=explorer'));
      await page.locator('.maplibregl-canvas').waitFor({ state: 'visible', timeout: 30000 });
      await page.locator('[data-tour-card]').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      for (const width of [320, 375, 390, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: explorer overflows at ${width}`);
      }
      await page.waitForFunction(async () => Boolean((await (await fetch('/api/v1/session')).json()).expiresAt));
      const session = await sessionResponse;
      assert.equal(session.status(), 200);
      const setCookie = (await session.allHeaders())['set-cookie'];
      assert(/SameSite=strict/i.test(setCookie), 'Server must explicitly set SameSite=Strict');
      const cookie = (await context.cookies()).find((cookie) => cookie.name === 'terrafield-demo-session');
      // WebKit's Windows protocol reports None even for a Strict response;
      // test the actual response AND cross-site withholding, not just metadata.
      assert(cookie?.httpOnly);
      if (base.startsWith('https:')) assert(cookie.secure);
      assert(!(await page.evaluate(() => document.cookie)).includes('terrafield-demo-session'));
      const response = await context.request.get(`${base}/about`);
      assert.equal(response.status(), 200);
      const html = await response.text();
      assert(html.includes('Where does the data come from?') && html.includes('https://terrafieldatlas.us/about'));
      assert.deepEqual(errors, [], `${name}: uncaught page errors`);
      await page.route('https://cross-site.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html>Cross-site isolation check</html>' }));
      await page.goto('https://cross-site.example/');
      const crossSiteRequest = page.waitForRequest(`${base}/api/v1/session`);
      await page.evaluate((base) => { const image = new Image(); image.src = `${base}/api/v1/session`; document.body.append(image); }, base);
      const outgoing = await (await crossSiteRequest).allHeaders();
      assert(!(outgoing.cookie || '').includes('terrafield-demo-session'), 'Session must be withheld cross-site');
      console.log(`PASS ${name}: phone/tablet/desktop overflow, mobile explorer, session cookie, server HTML`);
      await context.close();
    } finally { await browser.close(); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });