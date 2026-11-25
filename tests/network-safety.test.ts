import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createPinnedLookup, fetchPinnedPublicUrl, resolvePinnedTarget, resolvePublicTarget } from '@/lib/network-safety';

describe('public outbound target pinning', () => {
  test('resolves once and pins the validated address instead of re-resolving', async () => {
    let calls = 0;
    const resolved = await resolvePublicTarget('https://rebind.example.test/path', async () => {
      calls += 1;
      return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(calls).toBe(1);
    expect(resolved.target.address).toBe('93.184.216.34');
    const lookup = createPinnedLookup(resolved.target);
    const connected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup('rebind.example.test', { all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(connected).toEqual({ address: '93.184.216.34', family: 4 });
  });

  test('rejects mixed public and private DNS answers', async () => {
    const resolved = await resolvePublicTarget('https://mixed.example.test/path', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    expect(resolved.ok).toBe(false);
  });

  test('rejects mapped IPv6 DNS answers before any connection', async () => {
    const resolved = await resolvePublicTarget('https://mapped.example.test/path', async () => [
      { address: '::ffff:127.0.0.1', family: 6 },
    ]);
    expect(resolved.ok).toBe(false);
  });

  test('explicit private targets are still pinned to one resolved address', async () => {
    let calls = 0;
    const resolved = await resolvePinnedTarget('http://relay.internal:4317/hook', async () => {
      calls += 1;
      return [{ address: calls === 1 ? '127.0.0.1' : '10.0.0.8', family: 4 }];
    }, true);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.address).toBe('127.0.0.1');
    expect(calls).toBe(1);
  });

  test('pinned transport preserves Host and never follows redirects', async () => {
    let host = '';
    let internalHits = 0;
    const server = createServer((request, response) => {
      host = String(request.headers.host ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/internal' });
        response.end();
        return;
      }
      internalHits += 1;
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    try {
      const response = await fetchPinnedPublicUrl(`http://rebind.example.test:${address.port}/redirect`, {
        resolver: async () => [{ address: '127.0.0.1', family: 4 }],
        allowPrivate: true,
      });
      expect(response.status).toBe(302);
      expect(host).toBe(`rebind.example.test:${address.port}`);
      expect(internalHits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('pinned transport enforces response byte limits', async () => {
    const server = createServer((_request, response) => response.end('x'.repeat(128)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    try {
      await expect(fetchPinnedPublicUrl(`http://127.0.0.1:${address.port}/`, { allowPrivate: true, maxResponseBytes: 32 })).rejects.toThrow(/exceeds 32 bytes/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('pinned transport accepts bodyless 204 responses', async () => {
    const server = createServer((_request, response) => { response.writeHead(204); response.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    try {
      const response = await fetchPinnedPublicUrl(`http://127.0.0.1:${address.port}/`, { allowPrivate: true });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('refuses unsafe literals before invoking a resolver', async () => {
    let calls = 0;
    const resolved = await resolvePublicTarget('http://127.0.0.1:8080/admin', async () => {
      calls += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    });
    expect(resolved.ok).toBe(false);
    expect(calls).toBe(0);
    await expect(fetchPinnedPublicUrl('http://[::ffff:7f00:1]/admin')).rejects.toThrow(/SSRF|non-global|refused/i);
  });
});
