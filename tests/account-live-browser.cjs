const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { chromium, firefox, webkit } = require('../tools/browser-check/node_modules/playwright');
const ssh = ['-i', join(homedir(), '.ssh', 'work'), '-o', 'BatchMode=yes', 'ubuntu@57.130.80.158'];
const remote = mode => execFileSync('ssh', [...ssh, `cd /home/ubuntu/ai-azimara-terrafield; node scripts/account-live-fixture.cjs ${mode}`], { encoding: 'utf8' });

(async () => {
  try {
    const credentials = JSON.parse(remote('setup'));
    console.log('PASS live registration, Resend verification email, verification and replay rejection');
    for (const [name, engine, options] of [['Edge', chromium, { channel: 'msedge' }], ['Firefox', firefox, {}], ['WebKit', webkit, {}]]) {
      const browser = await engine.launch(options);
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        await page.goto('https://terrafieldatlas.us/account');
        await page.getByLabel('Email', { exact: true }).fill(credentials.email);
        await page.getByLabel('Password', { exact: true }).fill(credentials.password);
        const callback = page.waitForResponse(response => response.url().includes('/api/auth/callback/credentials'));
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        const setCookie = (await (await callback).allHeaders())['set-cookie'] || '';
        assert.match(setCookie, /next-auth\.session-token=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /Secure/i);
        assert.match(setCookie, /SameSite=Lax/i);
        await page.getByRole('button', { name: 'Sign out account', exact: true }).waitFor({ timeout: 30000 });
        const cookies = await context.cookies();
        assert.ok(cookies.some(cookie => cookie.name.includes('next-auth.session-token') && cookie.httpOnly && cookie.secure));
        await context.route('https://cross-site.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<html>Cross-site cookie probe</html>' }));
        const probe = await context.newPage();
        await probe.goto('https://cross-site.invalid');
        const outgoing = probe.waitForRequest(request => request.url().includes('/api/auth/session?crossSiteProbe'));
        await probe.evaluate(() => { const image = new Image(); image.src = 'https://terrafieldatlas.us/api/auth/session?crossSiteProbe=1'; document.body.append(image); });
        assert.doesNotMatch((await (await outgoing).allHeaders()).cookie || '', /next-auth\.session-token/);
        await probe.close();
        const created = await page.evaluate(async () => {
          const response = await fetch('/api/v1/farms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live browser validation fixture', centroidLat: 0, centroidLon: 0 }) });
          return { status: response.status, data: await response.json() };
        });
        assert.equal(created.status, 201);
        const id = created.data.farm.id;
        const anonymous = await browser.newContext();
        const denied = await anonymous.request.get(`https://terrafieldatlas.us/api/v1/farms/${id}`);
        assert.equal(denied.status(), 404);
        await anonymous.close();
        await page.getByRole('button', { name: 'Sign out account', exact: true }).click();
        await page.getByRole('link', { name: 'Private account', exact: true }).waitFor({ timeout: 30000 });
        assert.equal(await page.evaluate(async farm => (await fetch(`/api/v1/farms/${farm}`)).status, id), 404);
        console.log(`PASS ${name}: real account login, secure session, private farm creation, anonymous denial and logout`);
      } finally { await browser.close(); }
    }
  } finally { remote('cleanup'); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });