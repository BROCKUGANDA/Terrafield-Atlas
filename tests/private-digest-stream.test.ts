import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createDigestHub } from '@/lib/fires/digest-push';
import { createPostgresTestDatabase, deployMigrations } from './postgres-test-database';

test('private audience is opt-in, revalidated, and fail-closed; public stays broadcast', async () => {
  const hub = createDigestHub();
  const frames: Record<string, string[]> = { anonymous: [], owner: [], other: [], unchecked: [] };
  let valid = true;
  let closed = false;
  hub.register({ clientId: 'anonymous', send: (s) => frames.anonymous.push(s) });
  hub.register({ clientId: 'owner', ownerId: 'a', authorizePrivate: async () => valid, close: () => { closed = true; }, send: (s) => frames.owner.push(s) });
  hub.register({ clientId: 'other', ownerId: 'b', authorizePrivate: async () => true, send: (s) => frames.other.push(s) });
  hub.register({ clientId: 'unchecked', ownerId: 'a', send: (s) => frames.unchecked.push(s) });
  expect((await hub.publishPrivate('digest', { secret: true }, 'a')).delivered).toBe(1);
  expect(frames.anonymous).toEqual([]);
  expect(frames.other).toEqual([]);
  expect(frames.unchecked).toEqual([]);
  expect(frames.owner).toHaveLength(1);
  expect(hub.publish('public', {}).delivered).toBe(3);
  valid = false;
  expect((await hub.publishPrivate('digest', {}, 'a')).delivered).toBe(0);
  expect(closed).toBe(true);
});

test('private validation errors fail closed and disconnected sinks cannot receive late authorization', async () => {
  const hub = createDigestHub();
  let sent = 0;
  hub.register({ clientId: 'error', ownerId: 'a', authorizePrivate: async () => { throw new Error('database unavailable'); }, send: () => { sent++; } });
  expect((await hub.publishPrivate('digest', {}, 'a')).delivered).toBe(0);
  let release!: (valid: boolean) => void;
  hub.register({ clientId: 'slow', ownerId: 'a', authorizePrivate: () => new Promise((resolve) => { release = resolve; }), send: () => { sent++; } });
  const pending = hub.publishPrivate('digest', {}, 'a');
  hub.unregister('slow');
  release(true);
  expect((await pending).delivered).toBe(0);
  expect(sent).toBe(0);
});

if (process.env.PRIVATE_STREAM_WORKER !== '1') {
  test('real SSE route binds signed sessions and rechecks account and expiry', () => {
    const result = spawnSync(process.execPath, ['test', 'tests/private-digest-stream.test.ts'], {
      env: { ...process.env, PRIVATE_STREAM_WORKER: '1' }, encoding: 'utf8', timeout: 60_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 65_000);
} else {
  const database = await createPostgresTestDatabase('private_stream');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'private-stream-test-secret-only';
  process.env.DIGEST_PUSH_OFF = '0';
  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  const { db } = await import('@/lib/db');
  const { encode } = await import('next-auth/jwt');
  const { NextRequest } = await import('next/server');
  const { GET } = await import('@/app/api/v1/fires/watchlists/digest-stream/route');
  const { digestChannel } = await import('@/lib/fires/digest-channel');

  test('route ignores forged owner, expires token, and closes revoked account stream', async () => {
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const connect = async (owner: string | null, maxAge = 3600) => {
      const cookie = owner ? `next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: owner }, maxAge })}` : '';
      const res = await GET(new NextRequest('http://localhost/api/v1/fires/watchlists/digest-stream?ownerId=forged', { headers: { cookie, 'x-owner-id': 'forged' } }));
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      expect(res.headers.get('Cache-Control')).toContain('no-transform');
      const reader = res.body!.getReader();
      readers.push(reader);
      await reader.read(); // retry
      await reader.read(); // hello
      return reader;
    };
    try {
      const a = await db.accountUser.create({ data: { email: 'stream-a@example.test', emailVerified: new Date() } });
      const b = await db.accountUser.create({ data: { email: 'stream-b@example.test', emailVerified: new Date() } });
      const owner = await connect(a.id);
      await connect(b.id);
      const anonymous = await connect(null);
      const missing = await connect('missing-account');
      const hub = digestChannel();
      expect((await hub.publishPrivate('digest', { secret: 'a' }, a.id)).delivered).toBe(1);
      expect(new TextDecoder().decode((await owner.read()).value)).toContain('"secret":"a"');
      expect((await hub.publishPrivate('digest', {}, 'forged')).delivered).toBe(0);
      await db.accountUser.update({ where: { id: a.id }, data: { emailVerified: null } });
      expect((await hub.publishPrivate('digest', {}, a.id)).delivered).toBe(0);
      expect((await owner.read()).done).toBe(true);
      const short = await connect(b.id, 1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // Both b streams share the same active account; only the short token expires.
      expect((await hub.publishPrivate('digest', {}, b.id)).delivered).toBe(1);
      expect((await short.read()).done).toBe(true);
      await db.accountUser.delete({ where: { id: b.id } });
      expect((await hub.publishPrivate('digest', {}, b.id)).delivered).toBe(0);
      expect(hub.publish('public', {}).delivered).toBe(2);
      for (const reader of [anonymous, missing]) {
        const frame = new TextDecoder().decode((await reader.read()).value);
        expect(frame).toContain('event: public');
        expect(frame).not.toContain('secret');
      }
    } finally {
      for (const reader of readers) await reader.cancel();
      await db.$disconnect();
      await database.drop();
    }
  });
}