const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { homedir } = require('node:os');

(async () => {
  const vault = 'D:\\access and keys';
  const resend = fs.readFileSync(path.join(vault, 'resend .txt'), 'utf8').match(/re_[A-Za-z0-9_-]+/)?.[0];
  if (!resend) throw new Error('No Resend API key found');
  const domainsResponse = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${resend}` }, signal: AbortSignal.timeout(15000) });
  if (!domainsResponse.ok) throw new Error(`Resend domains HTTP ${domainsResponse.status}`);
  const domains = (await domainsResponse.json()).data || [];
  const verified = domains.filter(domain => domain.status === 'verified');
  console.log('Verified sender domains:', verified.map(domain => domain.name).join(', ') || 'none');
  const domain = verified.find(domain => domain.name === 'terrafieldatlas.us') || verified[0];
  const updates = {
    RESEND_API_KEY: resend,
    NEXTAUTH_URL: 'https://terrafieldatlas.us',
    DIGEST_WEBHOOK_URL: 'https://terrafieldatlas.us/api/v1/webhooks/digests',
  };
  if (domain) {
    updates.EMAIL_FROM = `TerraField Atlas <alerts@${domain.name}>`;
    updates.DIGEST_EMAIL_FROM = updates.EMAIL_FROM;
    updates.DIGEST_EMAIL_TO = 'delivered@resend.dev';
  }
  if (process.env.FIRMS_MAP_KEY) updates.FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;
  const candidates = fs.readdirSync(vault).filter(name => /^client_secret_.*\.json$/.test(name));
  for (const name of candidates) {
    const config = JSON.parse(fs.readFileSync(path.join(vault, name), 'utf8'));
    const client = config.web;
    const eligible = client?.redirect_uris?.includes('https://terrafieldatlas.us/api/auth/callback/google');
    console.log('OAuth candidate:', name, 'TerraField redirect authorized:', Boolean(eligible));
    if (eligible && client.client_id && client.client_secret) {
      updates.GOOGLE_CLIENT_ID = client.client_id;
      updates.GOOGLE_CLIENT_SECRET = client.client_secret;
      break;
    }
  }
  execFileSync('ssh', ['-i', path.join(homedir(), '.ssh', 'work'), '-o', 'BatchMode=yes', 'ubuntu@57.130.80.158', 'python3 /home/ubuntu/configure-terrafield-env.py'], {
    input: JSON.stringify({ updates, defaults: { NEXTAUTH_SECRET: randomBytes(48).toString('hex'), DIGEST_WEBHOOK_SECRET: randomBytes(48).toString('hex') } }), stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('Provider credentials transferred privately; values withheld. Digest destination is Resend test inbox only.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });