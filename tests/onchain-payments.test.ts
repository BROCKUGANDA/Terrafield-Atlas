import { afterAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import { canonicalKey } from '@/lib/redis';
import { createFetchMock } from './fetch-mock';
import { createPostgresTestDatabase, deployMigrations, enableTenantRlsTest } from './postgres-test-database';

/**
 * Contract compilation is pure and always runs. The integration suite below is
 * isolated in a child process because DATABASE_URL/TENANT_DATABASE_URL must be
 * set before the Prisma client and route modules load.
 */

test('support contract compiles and its ABI exposes the support surface', () => {
  const compiled = spawnSync(process.execPath, ['scripts/compile-contract.mjs'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  if (compiled.status !== 0) console.error(compiled.stdout, compiled.stderr);
  expect(compiled.status).toBe(0);

  const artifact = JSON.parse(readFileSync(resolve('contracts/abi/TerraFieldSupport.json'), 'utf8')) as {
    abi: Array<{ type: string; name?: string; stateMutability?: string; inputs?: Array<{ name: string; type: string; indexed?: boolean }>; outputs?: Array<{ type: string }> }>;
    bytecode: string;
  };
  expect(artifact.bytecode.startsWith('0x')).toBe(true);
  expect(artifact.bytecode.length).toBeGreaterThan(1000);

  const support = artifact.abi.find((entry) => entry.type === 'event' && entry.name === 'Support');
  expect(support).toBeTruthy();
  expect(support!.inputs?.map((input) => [input.name, input.type, input.indexed === true])).toEqual([
    ['payer', 'address', true],
    ['token', 'address', true],
    ['amount', 'uint256', false],
    ['memo', 'bytes32', true],
  ]);

  const native = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'supportNative');
  expect(native?.stateMutability).toBe('payable');
  expect(native?.inputs?.map((input) => input.type)).toEqual(['bytes32']);

  const token = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'supportToken');
  expect(token?.stateMutability).toBe('nonpayable');
  expect(token?.inputs?.map((input) => input.type)).toEqual(['address', 'uint256', 'bytes32']);

  const treasury = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'treasury');
  expect(treasury?.stateMutability).toBe('view');
  expect(treasury?.outputs?.map((output) => output.type)).toEqual(['address']);

  const setTreasury = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'setTreasury');
  expect(setTreasury?.stateMutability).toBe('nonpayable');
  expect(setTreasury?.inputs?.map((input) => input.type)).toEqual(['address']);
});

if (process.env.ONCHAIN_PAYMENTS_TEST_WORKER !== '1') {
  test('onchain support payments integration (isolated process)', () => {
    const result = spawnSync(process.execPath, ['test', './tests/onchain-payments.test.ts'], {
      env: { ...process.env, ONCHAIN_PAYMENTS_TEST_WORKER: '1' },
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 245_000);
} else {
  const TREASURY = '0x1111111111111111111111111111111111111111';
  const TOKEN = '0x2222222222222222222222222222222222222222';
  const OTHER = '0x4444444444444444444444444444444444444444';
  const PAYER = '0x3333333333333333333333333333333333333333';
  const SUPPORT_CONTRACT = '0x5555555555555555555555555555555555555555';
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  // keccak256("Support(address,address,uint256,bytes32)")
  const SUPPORT_TOPIC = '0x76abdcec7c22c39cf3fe1754f55de70c4feeb517cea1e874174ec9bf0d06e85e';
  const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

  const database = await createPostgresTestDatabase('onchain_payments');
  process.env.DATABASE_URL = database.url;
  process.env.NEXTAUTH_SECRET = 'onchain-payments-test-secret-not-production';
  process.env.NEXTAUTH_URL = 'https://onchain.example.test';
  process.env.WATCH_SCHEDULER_OFF = '1';
  process.env.TENANT_RLS_TEST = '1';
  process.env.ONCHAIN_RPC_URL = 'https://rpc.onchain.test/';
  process.env.ONCHAIN_CHAIN_ID = '8453';
  process.env.ONCHAIN_TREASURY = TREASURY;
  process.env.ONCHAIN_TOKEN_ADDRESS = TOKEN;
  process.env.ONCHAIN_TOKEN_SYMBOL = 'USDC';
  process.env.ONCHAIN_TOKEN_DECIMALS = '6';
  process.env.ONCHAIN_CONFIRMATIONS = '3';
  process.env.ONCHAIN_SUPPORT_CONTRACT = SUPPORT_CONTRACT;
  if (!process.env.REDIS_URL && process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;

  const setup = deployMigrations(database.url);
  if (setup.status !== 0) throw new Error(`${setup.stdout}\n${setup.stderr}`);
  await enableTenantRlsTest(database.url);

  // DATABASE_URL/TENANT_DATABASE_URL must be set before these imports.
  const { rawDb } = await import('@/lib/db');
  const { NextRequest } = await import('next/server');
  const { encode } = await import('next-auth/jwt');
  const configRoutes = await import('@/app/api/v1/billing/onchain/config/route');
  const intentsRoutes = await import('@/app/api/v1/billing/onchain/intents/route');
  const intentRoutes = await import('@/app/api/v1/billing/onchain/intents/[id]/route');
  const verifyRoutes = await import('@/app/api/v1/billing/onchain/intents/[id]/verify/route');
  const settleRoutes = await import('@/app/api/v1/billing/invoices/[invoiceId]/settle/route');
  const { ensurePlans } = await import('@/lib/commercial');

  const hex = (value: bigint) => `0x${value.toString(16)}`;
  const hex32 = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
  const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

  interface RpcState {
    chainId: string;
    latest: bigint;
    receipt: unknown;
    transaction: unknown;
    calls: string[];
  }
  const rpcState: RpcState = { chainId: '0x2105', latest: 102n, receipt: null, transaction: null, calls: [] };

  function erc20Receipt(txHash: string, options: {
    status?: string;
    blockNumber?: bigint;
    from?: string;
    token?: string;
    to?: string;
    amount?: bigint;
  } = {}) {
    return {
      transactionHash: txHash,
      status: options.status ?? '0x1',
      blockNumber: hex(options.blockNumber ?? 100n),
      from: options.from ?? PAYER,
      logs: [{
        address: options.token ?? TOKEN,
        topics: [TRANSFER_TOPIC, topicAddress(options.from ?? PAYER), topicAddress(options.to ?? TREASURY)],
        data: hex32(options.amount ?? 10_000_000n),
        transactionHash: txHash,
      }],
    };
  }

  function nativeReceipt(txHash: string, options: { status?: string; blockNumber?: bigint; from?: string } = {}) {
    return {
      transactionHash: txHash,
      status: options.status ?? '0x1',
      blockNumber: hex(options.blockNumber ?? 100n),
      from: options.from ?? PAYER,
      logs: [],
    };
  }

  function nativeTransaction(txHash: string, options: { to?: string; value?: bigint } = {}) {
    return { hash: txHash, to: options.to ?? TREASURY, value: hex(options.value ?? 10_000_000_000_000_000_000n), from: PAYER };
  }

  globalThis.fetch = createFetchMock(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://rpc.onchain.test')) throw new Error(`unexpected fetch: ${url}`);
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) as { id?: number; method?: string } : {};
    const method = payload.method ?? '';
    rpcState.calls.push(method);
    let result: unknown = null;
    if (method === 'eth_chainId') result = rpcState.chainId;
    else if (method === 'eth_blockNumber') result = hex(rpcState.latest);
    else if (method === 'eth_getTransactionReceipt') result = rpcState.receipt;
    else if (method === 'eth_getTransactionByHash') result = rpcState.transaction;
    else throw new Error(`unexpected RPC method: ${method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await ensurePlans();
  const plan = await rawDb.plan.findUniqueOrThrow({ where: { code: 'professional' } });
  const [owner, analyst, outsider, admin] = await Promise.all(['owner', 'analyst', 'outsider', 'admin'].map((name) => rawDb.accountUser.create({
    data: { email: `${name}@onchain.example.test`, emailVerified: new Date(), ...(name === 'admin' ? { isAdmin: true } : {}) },
  })));
  const organization = await rawDb.organization.create({ data: { name: 'Onchain Support Cooperative', slug: `onchain-support-${crypto.randomUUID().slice(0, 8)}` } });
  await rawDb.membership.create({ data: { organizationId: organization.id, userId: owner.id, role: 'owner' } });
  await rawDb.membership.create({ data: { organizationId: organization.id, userId: analyst.id, role: 'analyst' } });
  await rawDb.membership.create({ data: { organizationId: organization.id, userId: admin.id, role: 'owner' } });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const addMonths = (date: Date, months: number) => new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  ));
  const subscription = await rawDb.subscription.create({
    data: { organizationId: organization.id, planId: plan.id, status: 'past_due', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
  });

  const cookieFor = async (user: { id: string }) => `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { sub: user.id }, maxAge: 3600 })}`;
  const [ownerCookie, analystCookie, outsiderCookie, adminCookie] = await Promise.all([owner, analyst, outsider, admin].map(cookieFor));

  const redisPrefix = process.env.REDIS_KEY_PREFIX ?? 'terrafield:runtime:';
  const rateBucketKey = (kind: 'intent' | 'verify', tenant: string) => `${redisPrefix}bucket:${canonicalKey(`rate:onchain:${kind}:${tenant}`)}`;
  beforeEach(async () => {
    // Test isolation only: reset this suite's tenant buckets, not other suites.
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      await redis.del(...[
        rateBucketKey('intent', organization.id),
        rateBucketKey('verify', organization.id),
        rateBucketKey('intent', owner.id),
        rateBucketKey('verify', owner.id),
        rateBucketKey('intent', outsider.id),
        rateBucketKey('verify', outsider.id),
      ]);
    } finally {
      await redis.quit();
    }
  });

  let sequence = 0;
  const ctx = <T extends Record<string, string> = Record<string, string>>(params: T = {} as T) => ({ params: Promise.resolve(params) });
  const request = (
    path: string,
    method = 'GET',
    cookie?: string,
    body?: unknown,
    organizationId?: string,
    idempotencyKey?: string,
  ) => new NextRequest(`${process.env.NEXTAUTH_URL}/api/v1/${path}`, {
    method,
    headers: {
      origin: process.env.NEXTAUTH_URL!,
      'content-type': 'application/json',
      'x-forwarded-for': `onchain-${sequence++}`,
      ...(cookie ? { cookie } : {}),
      ...(organizationId ? { 'x-terrafield-organization': organizationId } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'idempotency-key': idempotencyKey ?? `onchain-test-${sequence}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const createIntent = async (amountMinor: number, options: { invoiceId?: string; cookie?: string } = {}) => intentsRoutes.POST(
    request('billing/onchain/intents', 'POST', options.cookie ?? ownerCookie, { amountMinor, ...(options.invoiceId ? { invoiceId: options.invoiceId } : {}) }, organization.id),
    ctx(),
  );
  const verifyIntent = async (intentId: string, txHash: string, options: { cookie?: string; key?: string; organizationId?: string } = {}) => verifyRoutes.POST(
    request(`billing/onchain/intents/${intentId}/verify`, 'POST', options.cookie ?? ownerCookie, { txHash }, options.organizationId ?? organization.id, options.key),
    ctx({ id: intentId }),
  );
  interface TestIntent {
    id: string;
    status: string;
    invoiceId: string | null;
    amountUnits: string;
    tokenSymbol: string;
    tokenAddress: string;
    tokenDecimals: number;
    chainId: number;
    treasuryAddress: string;
    memo: string;
    createdAt: string;
    expiresAt: string;
    paidAt: string | null;
  }
  interface TestPayment {
    txHash: string;
    amountUnits: string;
    confirmations: number;
    blockNumber: string | null;
    fromAddress: string;
    tokenAddress: string;
  }
  interface TestApiBody {
    enabled: boolean;
    tokenAddress: string | null;
    rpcUrl?: string;
    missing: string[];
    chainId: number;
    treasuryAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    supportContractAddress: string | null;
    confirmations: number;
    minAmountMinor: number;
    maxAmountMinor: number;
    native: boolean;
    paymentNote: string;
    intent: TestIntent;
    payment: TestPayment;
    error: { code: string; message?: string };
  }
  const json = async (response: Response) => response.json() as Promise<TestApiBody>;

  let paidIntentId = '';
  let paidTxHash = '';

  afterAll(async () => {
    await rawDb.$disconnect();
    await database.drop();
  });

  test('unconfigured deployment returns enabled:false and rejects mutations with 503', async () => {
    const saved = {
      url: process.env.ONCHAIN_RPC_URL,
      chain: process.env.ONCHAIN_CHAIN_ID,
      treasury: process.env.ONCHAIN_TREASURY,
      token: process.env.ONCHAIN_TOKEN_ADDRESS,
      symbol: process.env.ONCHAIN_TOKEN_SYMBOL,
      decimals: process.env.ONCHAIN_TOKEN_DECIMALS,
      confirmations: process.env.ONCHAIN_CONFIRMATIONS,
    };
    for (const key of ['ONCHAIN_RPC_URL', 'ONCHAIN_CHAIN_ID', 'ONCHAIN_TREASURY', 'ONCHAIN_TOKEN_ADDRESS', 'ONCHAIN_TOKEN_SYMBOL', 'ONCHAIN_TOKEN_DECIMALS', 'ONCHAIN_CONFIRMATIONS']) {
      delete process.env[key];
    }
    try {
      const config = await configRoutes.GET(request('billing/onchain/config'), ctx());
      expect(config.status).toBe(200);
      const body = await json(config);
      expect(body.enabled).toBe(false);
      expect(body.tokenAddress).toBeNull();
      expect(body.rpcUrl).toBeUndefined();
      expect(body.missing).toContain('ONCHAIN_RPC_URL');

      const denied = await createIntent(1000);
      expect(denied.status).toBe(503);
      expect((await json(denied)).error.code).toBe('ONCHAIN_NOT_CONFIGURED');
    } finally {
      process.env.ONCHAIN_RPC_URL = saved.url;
      process.env.ONCHAIN_CHAIN_ID = saved.chain;
      process.env.ONCHAIN_TREASURY = saved.treasury;
      process.env.ONCHAIN_TOKEN_ADDRESS = saved.token;
      process.env.ONCHAIN_TOKEN_SYMBOL = saved.symbol;
      process.env.ONCHAIN_TOKEN_DECIMALS = saved.decimals;
      process.env.ONCHAIN_CONFIRMATIONS = saved.confirmations;
    }
  });

  test('config exposes recipient/token but redacts the RPC endpoint', async () => {
    const response = await configRoutes.GET(request('billing/onchain/config'), ctx());
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.enabled).toBe(true);
    expect(body.chainId).toBe(8453);
    expect(body.treasuryAddress).toBe(TREASURY);
    expect(body.tokenAddress).toBe(TOKEN);
    expect(body.tokenSymbol).toBe('USDC');
    expect(body.tokenDecimals).toBe(6);
    expect(body.supportContractAddress).toBe(SUPPORT_CONTRACT);
    expect(body.confirmations).toBe(3);
    expect(body.minAmountMinor).toBe(100);
    expect(body.maxAmountMinor).toBe(1_000_000);
    expect(body.paymentNote).toContain('voluntary');
    expect(JSON.stringify(body)).not.toContain('rpc.onchain.test');
    expect(body.rpcUrl).toBeUndefined();
  });

  test('creates a 30-minute intent with exact base units and enforces permissions/bounds', async () => {
    const created = await createIntent(2500);
    expect(created.status).toBe(201);
    const body = await json(created);
    const intent = body.intent;
    expect(intent.status).toBe('open');
    expect(intent.amountUnits).toBe('25000000');
    expect(intent.tokenSymbol).toBe('USDC');
    expect(intent.tokenDecimals).toBe(6);
    expect(intent.chainId).toBe(8453);
    expect(intent.treasuryAddress).toBe(TREASURY);
    expect(intent.memo).toMatch(/^0x[0-9a-f]{64}$/);
    const ttl = new Date(intent.expiresAt).getTime() - new Date(intent.createdAt).getTime();
    expect(ttl).toBe(30 * 60 * 1000);

    const fetched = await intentRoutes.GET(request(`billing/onchain/intents/${intent.id}`, 'GET', ownerCookie, undefined, organization.id), ctx({ id: intent.id }));
    expect(fetched.status).toBe(200);
    expect((await json(fetched)).intent.id).toBe(intent.id);

    const denied = await createIntent(1000, { cookie: analystCookie });
    expect(denied.status).toBe(403);

    const tooSmall = await createIntent(99);
    expect(tooSmall.status).toBe(400);
    expect((await json(tooSmall)).error.code).toBe('VALIDATION_ERROR');

    const tooLarge = await createIntent(1_000_001);
    expect(tooLarge.status).toBe(400);
  });

  test('rejects wrong chain, token, recipient, amount, revert, and shallow confirmations', async () => {
    const created = await createIntent(1000);
    const intent = (await json(created)).intent;
    const txHash = `0x${'a'.repeat(64)}`;

    rpcState.chainId = '0x1';
    rpcState.latest = 102n;
    rpcState.receipt = erc20Receipt(txHash);
    const wrongChain = await verifyIntent(intent.id, txHash);
    expect(wrongChain.status).toBe(409);
    expect((await json(wrongChain)).error.code).toBe('ONCHAIN_CHAIN_MISMATCH');

    rpcState.chainId = '0x2105';
    rpcState.receipt = erc20Receipt(txHash, { token: OTHER });
    const wrongToken = await verifyIntent(intent.id, txHash);
    expect(wrongToken.status).toBe(409);
    expect((await json(wrongToken)).error.code).toBe('ONCHAIN_TOKEN_MISMATCH');

    rpcState.receipt = erc20Receipt(txHash, { to: OTHER });
    const wrongRecipient = await verifyIntent(intent.id, txHash);
    expect(wrongRecipient.status).toBe(409);
    expect((await json(wrongRecipient)).error.code).toBe('ONCHAIN_RECIPIENT_MISMATCH');

    rpcState.receipt = erc20Receipt(txHash, { amount: 10_000_001n });
    const wrongAmount = await verifyIntent(intent.id, txHash);
    expect(wrongAmount.status).toBe(409);
    expect((await json(wrongAmount)).error.code).toBe('ONCHAIN_AMOUNT_MISMATCH');

    rpcState.receipt = erc20Receipt(txHash, { status: '0x0' });
    const reverted = await verifyIntent(intent.id, txHash);
    expect(reverted.status).toBe(409);
    expect((await json(reverted)).error.code).toBe('ONCHAIN_TX_REVERTED');

    rpcState.receipt = erc20Receipt(txHash);
    rpcState.latest = 101n;
    const shallow = await verifyIntent(intent.id, txHash);
    expect(shallow.status).toBe(409);
    expect((await json(shallow)).error.code).toBe('ONCHAIN_INSUFFICIENT_CONFIRMATIONS');

    expect(await rawDb.onchainPayment.count({ where: { intentId: intent.id } })).toBe(0);
  });

  test('malformed Transfer data is treated as a non-match, not an RPC error', async () => {
    const created = await createIntent(1000);
    const intent = (await json(created)).intent;
    const txHash = `0x${'9'.repeat(64)}`;
    const base = erc20Receipt(txHash);
    rpcState.latest = 102n;
    rpcState.receipt = { ...base, logs: base.logs.map((log) => ({ ...log, data: '0xzz' })) };
    const malformed = await verifyIntent(intent.id, txHash);
    expect(malformed.status).toBe(409);
    expect((await json(malformed)).error.code).toBe('ONCHAIN_AMOUNT_MISMATCH');
    expect(await rawDb.onchainPayment.count({ where: { intentId: intent.id } })).toBe(0);
  });

  test('rejects expired intents and unknown transactions', async () => {
    const created = await createIntent(1000);
    const intent = (await json(created)).intent;
    rpcState.latest = 102n;
    rpcState.receipt = null;
    rpcState.calls = [];
    const missing = await verifyIntent(intent.id, `0x${'b'.repeat(64)}`);
    expect(missing.status).toBe(409);
    expect((await json(missing)).error.code).toBe('ONCHAIN_TX_NOT_FOUND');
    expect(rpcState.calls).toEqual(['eth_getTransactionReceipt']);

    await rawDb.onchainPaymentIntent.update({ where: { id: intent.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await verifyIntent(intent.id, `0x${'c'.repeat(64)}`);
    expect(expired.status).toBe(409);
    expect((await json(expired)).error.code).toBe('INTENT_EXPIRED');

    const replacement = await createIntent(100);
    expect(replacement.status).toBe(201);
    const pruned = await rawDb.onchainPaymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(pruned.status).toBe('expired');
  });

  test('verifies an ERC20 transfer and refuses to record it twice', async () => {
    const created = await createIntent(1000);
    const intent = (await json(created)).intent;
    paidIntentId = intent.id;
    paidTxHash = `0x${'d'.repeat(64)}`;
    rpcState.chainId = '0x2105';
    rpcState.latest = 102n;
    rpcState.receipt = erc20Receipt(paidTxHash);
    rpcState.calls = [];

    const verified = await verifyIntent(paidIntentId, paidTxHash);
    expect(verified.status).toBe(200);
    const body = await json(verified);
    expect(body.intent.status).toBe('paid');
    expect(body.intent.paidAt).toBeTruthy();
    expect(body.payment.txHash).toBe(paidTxHash);
    expect(body.payment.amountUnits).toBe('10000000');
    expect(body.payment.confirmations).toBe(3);
    expect(body.payment.blockNumber).toBe('100');
    expect(body.payment.fromAddress).toBe(PAYER);
    expect(body.payment.tokenAddress).toBe(TOKEN);
    expect(rpcState.calls).toEqual(['eth_getTransactionReceipt', 'eth_chainId', 'eth_blockNumber']);

    const untouched = await rawDb.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(untouched.status).toBe('past_due');
    expect(untouched.currentPeriodStart?.getTime()).toBe(periodStart.getTime());
    expect(untouched.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime());

    expect(await rawDb.onchainPayment.count({ where: { intentId: paidIntentId } })).toBe(1);
    const stored = await rawDb.onchainPaymentIntent.findUniqueOrThrow({ where: { id: paidIntentId } });
    expect(stored.status).toBe('paid');

    const replay = await verifyIntent(paidIntentId, paidTxHash, { key: 'replay-paid-intent' });
    expect(replay.status).toBe(409);
    expect((await json(replay)).error.code).toBe('INTENT_ALREADY_PAID');
  });

  test('a transaction hash cannot be reused for another intent', async () => {
    const created = await createIntent(500);
    const intent = (await json(created)).intent;
    const reused = await verifyIntent(intent.id, paidTxHash);
    expect(reused.status).toBe(409);
    expect((await json(reused)).error.code).toBe('TX_ALREADY_USED');
  });

  test('concurrent verification records exactly one payment', async () => {
    const created = await createIntent(500);
    const intent = (await json(created)).intent;
    const txHash = `0x${'e'.repeat(64)}`;
    rpcState.receipt = erc20Receipt(txHash, { amount: 5_000_000n });
    rpcState.latest = 102n;

    const [first, second] = await Promise.all([
      verifyIntent(intent.id, txHash, { key: 'concurrent-verify-a' }),
      verifyIntent(intent.id, txHash, { key: 'concurrent-verify-b' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await rawDb.onchainPayment.count({ where: { intentId: intent.id } })).toBe(1);
    expect(await rawDb.onchainPayment.count({ where: { txHash } })).toBe(1);
    const stored = await rawDb.onchainPaymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stored.status).toBe('paid');
  });

  test('rate limits intent creation and verification per tenant', async () => {
    for (let index = 0; index < 10; index += 1) {
      const created = await createIntent(100);
      expect(created.status).toBe(201);
    }
    const blockedCreate = await createIntent(100);
    expect(blockedCreate.status).toBe(429);
    expect((await json(blockedCreate)).error.code).toBe('RATE_LIMITED');

    for (let index = 0; index < 6; index += 1) {
      const replay = await verifyIntent(paidIntentId, paidTxHash, { key: `rate-verify-${index}` });
      expect(replay.status).toBe(409);
      expect((await json(replay)).error.code).toBe('INTENT_ALREADY_PAID');
    }
    const blockedVerify = await verifyIntent(paidIntentId, paidTxHash, { key: 'rate-verify-blocked' });
    expect(blockedVerify.status).toBe(429);
    expect((await json(blockedVerify)).error.code).toBe('RATE_LIMITED');
  });

  test('native mode uses the gas coin and checks exact value and recipient', async () => {
    process.env.ONCHAIN_TOKEN_ADDRESS = 'native';
    delete process.env.ONCHAIN_TOKEN_SYMBOL;
    delete process.env.ONCHAIN_TOKEN_DECIMALS;
    try {
      const config = await json(await configRoutes.GET(request('billing/onchain/config'), ctx()));
      expect(config.native).toBe(true);
      expect(config.tokenSymbol).toBe('ETH');
      expect(config.tokenDecimals).toBe(18);

      const created = await createIntent(1000);
      const intent = (await json(created)).intent;
      expect(intent.tokenAddress).toBe('native');
      expect(intent.amountUnits).toBe('10000000000000000000');

      const txHash = `0x${'f'.repeat(64)}`;
      rpcState.latest = 102n;
      rpcState.receipt = nativeReceipt(txHash);
      rpcState.transaction = nativeTransaction(txHash, { value: 10_000_000_000_000_000_000n });
      const verified = await verifyIntent(intent.id, txHash);
      expect(verified.status).toBe(200);
      const body = await json(verified);
      expect(body.intent.status).toBe('paid');
      expect(body.payment.amountUnits).toBe('10000000000000000000');

      const second = await createIntent(1000);
      const secondIntent = (await json(second)).intent;
      const wrongRecipientHash = `0x${'1'.repeat(64)}`;
      rpcState.receipt = nativeReceipt(wrongRecipientHash);
      rpcState.transaction = nativeTransaction(wrongRecipientHash, { to: OTHER });
      const wrongRecipient = await verifyIntent(secondIntent.id, wrongRecipientHash);
      expect(wrongRecipient.status).toBe(409);
      expect((await json(wrongRecipient)).error.code).toBe('ONCHAIN_RECIPIENT_MISMATCH');

      const wrongValueHash = `0x${'2'.repeat(64)}`;
      rpcState.receipt = nativeReceipt(wrongValueHash);
      rpcState.transaction = nativeTransaction(wrongValueHash, { value: 10_000_000_000_000_000_001n });
      const wrongValue = await verifyIntent(secondIntent.id, wrongValueHash);
      expect(wrongValue.status).toBe(409);
      expect((await json(wrongValue)).error.code).toBe('ONCHAIN_AMOUNT_MISMATCH');

      const contractHash = `0x${'6'.repeat(64)}`;
      const amount = 10_000_000_000_000_000_000n;
      rpcState.receipt = {
        transactionHash: contractHash,
        status: '0x1',
        blockNumber: hex(100n),
        from: PAYER,
        logs: [{
          address: SUPPORT_CONTRACT,
          topics: [SUPPORT_TOPIC, topicAddress(PAYER), ZERO_TOPIC, secondIntent.memo],
          data: hex32(amount),
          transactionHash: contractHash,
        }],
      };
      rpcState.transaction = nativeTransaction(contractHash, { to: SUPPORT_CONTRACT, value: amount });
      const contractVerified = await verifyIntent(secondIntent.id, contractHash);
      expect(contractVerified.status).toBe(200);
      expect((await json(contractVerified)).intent.status).toBe('paid');

      const third = await createIntent(1000);
      const thirdIntent = (await json(third)).intent;
      const wrongMemoHash = `0x${'7'.repeat(64)}`;
      rpcState.receipt = {
        transactionHash: wrongMemoHash,
        status: '0x1',
        blockNumber: hex(100n),
        from: PAYER,
        logs: [{
          address: SUPPORT_CONTRACT,
          topics: [SUPPORT_TOPIC, topicAddress(PAYER), ZERO_TOPIC, `0x${'8'.repeat(64)}`],
          data: hex32(amount),
          transactionHash: wrongMemoHash,
        }],
      };
      rpcState.transaction = nativeTransaction(wrongMemoHash, { to: SUPPORT_CONTRACT, value: amount });
      const wrongMemo = await verifyIntent(thirdIntent.id, wrongMemoHash);
      expect(wrongMemo.status).toBe(409);
      expect((await json(wrongMemo)).error.code).toBe('ONCHAIN_NATIVE_EVENT_MISMATCH');
    } finally {
      process.env.ONCHAIN_TOKEN_ADDRESS = TOKEN;
      process.env.ONCHAIN_TOKEN_SYMBOL = 'USDC';
      process.env.ONCHAIN_TOKEN_DECIMALS = '6';
    }
  });

  test('invoice-linked verification settles once and activates the subscription', async () => {
    const invoice = await rawDb.invoice.create({
      data: {
        organizationId: organization.id,
        subscriptionId: subscription.id,
        number: `TF-ONCHAIN-${crypto.randomUUID().slice(0, 8)}`,
        status: 'open',
        amountMinor: 2500,
        currency: 'USD',
        periodStart,
        periodEnd,
        issuedAt: new Date(),
        dueAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });

    const publicLink = await createIntent(2500, { invoiceId: invoice.id });
    expect(publicLink.status).toBe(403);
    expect((await json(publicLink)).error.code).toBe('ONCHAIN_INVOICE_LINK_ADMIN_ONLY');
    expect((await rawDb.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('open');
    expect(await rawDb.payment.count({ where: { invoiceId: invoice.id } })).toBe(0);

    const mismatch = await createIntent(1000, { invoiceId: invoice.id, cookie: adminCookie });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).error.code).toBe('AMOUNT_MISMATCH');

    const created = await createIntent(2500, { invoiceId: invoice.id, cookie: adminCookie });
    expect(created.status).toBe(201);
    const intent = (await json(created)).intent;
    expect(intent.invoiceId).toBe(invoice.id);
    const txHash = `0x${'3'.repeat(64)}`;
    rpcState.chainId = '0x2105';
    rpcState.latest = 102n;
    rpcState.receipt = erc20Receipt(txHash, { amount: 25_000_000n });

    const managerVerify = await verifyIntent(intent.id, txHash, { cookie: ownerCookie, key: 'invoice-manager-verify' });
    expect(managerVerify.status).toBe(403);
    expect((await json(managerVerify)).error.code).toBe('ONCHAIN_INVOICE_LINK_ADMIN_ONLY');

    const shallow = await verifyIntent(intent.id, txHash, { cookie: adminCookie, key: 'invoice-shallow-verify' });
    expect(shallow.status).toBe(409);
    expect((await json(shallow)).error.code).toBe('ONCHAIN_INSUFFICIENT_CONFIRMATIONS');
    expect(await rawDb.payment.count({ where: { invoiceId: invoice.id } })).toBe(0);

    rpcState.latest = 106n; // 7 confirmations, above the 6-confirmation invoice floor
    const verified = await verifyIntent(intent.id, txHash, { cookie: adminCookie });
    expect(verified.status).toBe(200);
    const body = await json(verified);
    expect(body.intent.status).toBe('paid');

    const settledInvoice = await rawDb.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(settledInvoice.status).toBe('paid');
    const payment = await rawDb.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(payment.method).toBe('onchain');
    expect(payment.reference).toBe(txHash);
    expect(payment.status).toBe('succeeded');
    const updatedSubscription = await rawDb.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updatedSubscription.status).toBe('active');
    expect(updatedSubscription.currentPeriodStart?.getTime()).toBe(addMonths(periodStart, 1).getTime());
    expect(updatedSubscription.currentPeriodEnd?.getTime()).toBe(addMonths(periodEnd, 1).getTime());
    expect(await rawDb.payment.count({ where: { invoiceId: invoice.id } })).toBe(1);

    const secondVerify = await verifyIntent(intent.id, txHash, { cookie: adminCookie, key: 'invoice-double-verify' });
    expect(secondVerify.status).toBe(409);
    expect((await json(secondVerify)).error.code).toBe('INTENT_ALREADY_PAID');
  });

  test('the public manual settlement route cannot submit onchain', async () => {
    const invoice = await rawDb.invoice.create({
      data: {
        organizationId: organization.id,
        number: `TF-ONCHAIN-MANUAL-${crypto.randomUUID().slice(0, 8)}`,
        status: 'open',
        amountMinor: 1000,
        currency: 'USD',
        issuedAt: new Date(),
        dueAt: new Date(Date.now() + 86_400_000),
      },
    });
    const response = await settleRoutes.POST(
      request(`billing/invoices/${invoice.id}/settle`, 'POST', ownerCookie, { method: 'onchain', reference: `0x${'4'.repeat(64)}` }, organization.id),
      ctx({ invoiceId: invoice.id }),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('VALIDATION_ERROR');
    expect(await rawDb.payment.count({ where: { invoiceId: invoice.id } })).toBe(0);

    // The library layer also rejects a forged onchain method; only the verifier
    // can invoke the module-private settlement capability.
    const invoiceLedger = await import('@/lib/billing/invoices');
    await expect(invoiceLedger.settleInvoice({
      userId: owner.id,
      organizationId: organization.id,
      organizationName: organization.name,
      role: 'owner',
      permissions: ['billing.manage'],
      isPlatformAdmin: false,
    }, invoice.id, { method: 'onchain', reference: `0x${'4'.repeat(64)}` })).rejects.toMatchObject({ code: 'ONCHAIN_VERIFICATION_REQUIRED' });
    expect(await rawDb.payment.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  test('intents and verification are tenant-scoped', async () => {
    const outsiderGet = await intentRoutes.GET(request(`billing/onchain/intents/${paidIntentId}`, 'GET', outsiderCookie), ctx({ id: paidIntentId }));
    expect(outsiderGet.status).toBe(404);
    expect((await json(outsiderGet)).error.code).toBe('ONCHAIN_INTENT_NOT_FOUND');

    const outsiderVerify = await verifyIntent(paidIntentId, paidTxHash, { cookie: outsiderCookie, key: 'outsider-verify', organizationId: '' });
    expect(outsiderVerify.status).toBe(404);
    expect((await json(outsiderVerify)).error.code).toBe('ONCHAIN_INTENT_NOT_FOUND');

    const analystGet = await intentRoutes.GET(request(`billing/onchain/intents/${paidIntentId}`, 'GET', analystCookie, undefined, organization.id), ctx({ id: paidIntentId }));
    expect(analystGet.status).toBe(403);
  });
}
