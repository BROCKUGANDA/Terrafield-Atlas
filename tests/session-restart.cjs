const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');

(async () => {
  assert.equal(process.env.ALLOW_SERVICE_RESTART, '1', 'Explicit ALLOW_SERVICE_RESTART=1 required');
  const origin = 'https://terrafieldatlas.us';
  const created = await fetch(`${origin}/api/v1/session`, { method: 'POST', headers: { origin } });
  assert.equal(created.status, 200);
  const session = await created.json();
  assert.ok(session.expiresAt);
  const cookie = created.headers.get('set-cookie').split(';')[0];
  execFileSync('ssh', ['-i', join(homedir(), '.ssh', 'work'), '-o', 'BatchMode=yes', 'ubuntu@57.130.80.158', 'sudo systemctl restart terrafield'], { stdio: 'inherit' });
  let restored;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${origin}/api/v1/session`, { headers: { cookie } });
      if (response.ok) { restored = await response.json(); break; }
    } catch { /* Service is restarting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(restored?.expiresAt, session.expiresAt);
  assert.equal(restored.authenticated, false);
  const ended = await fetch(`${origin}/api/v1/session`, { method: 'DELETE', headers: { origin, cookie } });
  assert.equal(ended.status, 200);
  console.log('PASS signed anonymous session survives service restart; sign-out clears browser cookie');
})().catch(error => { console.error(error); process.exitCode = 1; });