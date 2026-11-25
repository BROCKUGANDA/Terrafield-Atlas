const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('../tools/browser-check/node_modules/playwright');
const ssh = ['-i', join(homedir(), '.ssh', 'work'), '-o', 'BatchMode=yes', 'ubuntu@57.130.80.158'];
const remote = mode => execFileSync('ssh', [...ssh, `cd /home/ubuntu/ai-azimara-terrafield; node scripts/account-live-fixture.cjs ${mode}`], { encoding: 'utf8' });

(async () => {
  let browser;
  try {
    const credentials = JSON.parse(remote('setup'));
    browser = await chromium.launch({ channel: 'msedge' });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://terrafieldatlas.us/account');
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out account', exact: true }).waitFor({ timeout: 30000 });
    const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(`/api/v1/${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }, { path, method, body });
    const created = await api('farms', 'POST', { name: 'Private workflow validation fixture', centroidLat: 1, centroidLon: 2 });
    assert.equal(created.status, 201);
    const farmId = created.data.farm.id;
    const ingested = await api('observations/ingest', 'POST', { farmId, years: 2, variables: ['T2M'] });
    assert.equal(ingested.status, 201, 'Live private POWER ingestion must complete');
    assert.ok(ingested.data.outcome.rowsWritten > 0);
    assert.equal((await api(`analysis/jobs/${ingested.data.job.id}`)).status, 200);
    const trends = await api('analysis/trends', 'POST', { farmId, variables: ['T2M'] });
    assert.equal(trends.status, 200);
    assert.ok(trends.data.observationCount > 0);
    assert.equal(trends.data.results.length, 1);
    assert.equal(trends.data.results[0].significant, false, 'Two years cannot support a significance claim');
    const watch = await api('fires/watchlists', 'POST', { name: 'Private workflow validation fixture', lat: 1, lon: 2, radiusKm: 5, lookbackDays: 3, reevaluateIntervalMin: 360 });
    assert.equal(watch.status, 201);
    assert.equal(watch.data.watchlist.reevaluateIntervalMin, 360);
    const id = watch.data.watchlist.id;
    const evaluated = await api(`fires/watchlists/${id}/evaluate`, 'POST', { end: '2024-07-25' });
    assert.equal(evaluated.status, 201, 'Live private watchlist evaluation must complete');
    assert.ok(evaluated.data.evaluation);
    if (evaluated.data.evaluation.daysNoData.length) assert.notEqual(evaluated.data.evaluation.status, 'clear');
    const digest = await api(`fires/watchlists/${id}/digest`);
    assert.equal(digest.status, 200);
    const anonymous = await browser.newContext();
    try {
      for (const path of [`farms/${farmId}`, `fires/watchlists/${id}`, `fires/watchlists/${id}/digest`, `analysis/jobs/${ingested.data.job.id}`, `analysis/jobs/${trends.data.jobId}`]) {
        assert.equal((await anonymous.request.get(`https://terrafieldatlas.us/api/v1/${path}`)).status(), 404);
      }
      const status = await (await anonymous.request.get('https://terrafieldatlas.us/api/v1/system/status')).json();
      assert.deepEqual(status.scheduler.dueNow, []);
      assert.ok(!JSON.stringify(status).includes(id));
      assert.ok(!JSON.stringify(status).includes('Private workflow validation fixture'));
    } finally { await anonymous.close(); }
    console.log('PASS live private POWER ingestion, trends, jobs, watchlist cadence/evaluation/digest; anonymous denial and sanitized diagnostics');
  } finally {
    if (browser) await browser.close();
    remote('cleanup');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });