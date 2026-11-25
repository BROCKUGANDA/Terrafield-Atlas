import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AccountAccessError } from '@/lib/access-error';
import { rateLimit, writeMutationEffects } from '@/lib/api/helpers';
import { settleVerifiedOnchainInvoiceInTransaction } from '@/lib/billing/invoices';
import { db, rawDb } from '@/lib/db';
import type { TenantContext } from '@/lib/tenancy';

/**
 * Voluntary onchain support payments.
 *
 * The server never holds a private key and never takes custody. An intent is a
 * quotation plus an opaque memo; verification reads a public JSON-RPC endpoint
 * and records the observed transaction. Support intents never alter
 * entitlements: TerraField stays freemium and support is voluntary. A platform
 * administrator may separately link an invoice as an explicit subscription
 * settlement; that path is not support and is guarded below.
 */

export const NATIVE_TOKEN = 'native';
export const ONCHAIN_MIN_AMOUNT_MINOR = 100; // $1.00
export const ONCHAIN_MAX_AMOUNT_MINOR = 1_000_000; // $10,000.00
export const ONCHAIN_INTENT_TTL_MS = 30 * 60 * 1000;
export const ONCHAIN_MIN_CONFIRMATIONS = 1;
export const DEFAULT_ONCHAIN_CONFIRMATIONS = 3;
/** Invoice-linked settlement is an admin subscription action, not support. */
export const ONCHAIN_INVOICE_MIN_CONFIRMATIONS = 6;

export const ONCHAIN_PAYMENT_NOTE =
  'Core TerraField features stay free. Onchain support is voluntary and does not unlock or lock any capability. The server never holds a private key or custody of funds.';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256("Support(address,address,uint256,bytes32)")
const SUPPORT_EVENT_TOPIC = '0x76abdcec7c22c39cf3fe1754f55de70c4feeb517cea1e874174ec9bf0d06e85e';
const ZERO_ADDRESS_TOPIC = `0x${'0'.repeat(64)}`;

export interface OnchainConfig {
  enabled: boolean;
  rpcUrl: string | null;
  chainId: number | null;
  treasuryAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  supportContractAddress: string | null;
  confirmations: number;
  expiresMinutes: number;
  minAmountMinor: number;
  maxAmountMinor: number;
  native: boolean;
  missing: string[];
}

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDecimals(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : null;
}

/** Read and validate environment configuration on every call (deployments can rotate RPC endpoints). */
export function readOnchainConfig(): OnchainConfig {
  const missing: string[] = [];
  const rpcUrl = envValue('ONCHAIN_RPC_URL');
  if (!rpcUrl) missing.push('ONCHAIN_RPC_URL');
  else if (!/^https?:\/\//i.test(rpcUrl)) missing.push('ONCHAIN_RPC_URL');

  const chainId = parsePositiveInt(envValue('ONCHAIN_CHAIN_ID'));
  if (!chainId) missing.push('ONCHAIN_CHAIN_ID');

  const treasuryAddress = envValue('ONCHAIN_TREASURY');
  if (!treasuryAddress || !ADDRESS_PATTERN.test(treasuryAddress)) missing.push('ONCHAIN_TREASURY');

  const rawTokenAddress = envValue('ONCHAIN_TOKEN_ADDRESS');
  const native = rawTokenAddress === NATIVE_TOKEN;
  const tokenAddress = rawTokenAddress && (native || ADDRESS_PATTERN.test(rawTokenAddress)) ? rawTokenAddress : null;
  if (!tokenAddress) missing.push('ONCHAIN_TOKEN_ADDRESS');

  const configuredDecimals = parseDecimals(envValue('ONCHAIN_TOKEN_DECIMALS'));
  const tokenDecimals = configuredDecimals ?? (native ? 18 : 6);
  if (envValue('ONCHAIN_TOKEN_DECIMALS') && configuredDecimals === null) missing.push('ONCHAIN_TOKEN_DECIMALS');

  const tokenSymbol = envValue('ONCHAIN_TOKEN_SYMBOL') ?? (native ? 'ETH' : 'USDC');
  if (tokenSymbol.length > 16) missing.push('ONCHAIN_TOKEN_SYMBOL');

  const rawSupportContract = envValue('ONCHAIN_SUPPORT_CONTRACT');
  const supportContractAddress = rawSupportContract && ADDRESS_PATTERN.test(rawSupportContract) ? rawSupportContract : null;
  if (rawSupportContract && !supportContractAddress) missing.push('ONCHAIN_SUPPORT_CONTRACT');

  const rawConfirmations = envValue('ONCHAIN_CONFIRMATIONS');
  const parsedConfirmations = rawConfirmations === null ? null : Number(rawConfirmations);
  const validConfirmations = parsedConfirmations !== null && Number.isSafeInteger(parsedConfirmations) && parsedConfirmations >= 0 ? parsedConfirmations : null;
  const confirmations = Math.max(ONCHAIN_MIN_CONFIRMATIONS, validConfirmations ?? DEFAULT_ONCHAIN_CONFIRMATIONS);

  return {
    enabled: missing.length === 0,
    rpcUrl,
    chainId,
    treasuryAddress,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    supportContractAddress,
    confirmations,
    expiresMinutes: ONCHAIN_INTENT_TTL_MS / 60_000,
    minAmountMinor: ONCHAIN_MIN_AMOUNT_MINOR,
    maxAmountMinor: ONCHAIN_MAX_AMOUNT_MINOR,
    native,
    missing,
  };
}

/** Safe projection for the client: never expose the RPC URL or any credential. */
export function publicOnchainConfig(config: OnchainConfig) {
  return {
    enabled: config.enabled,
    chainId: config.chainId,
    treasuryAddress: config.treasuryAddress,
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: config.tokenDecimals,
    supportContractAddress: config.supportContractAddress,
    native: config.native,
    confirmations: config.confirmations,
    expiresMinutes: config.expiresMinutes,
    minAmountMinor: config.minAmountMinor,
    maxAmountMinor: config.maxAmountMinor,
    missing: config.missing,
    paymentNote: ONCHAIN_PAYMENT_NOTE,
  };
}

function requireConfig(): OnchainConfig {
  const config = readOnchainConfig();
  if (!config.enabled) {
    throw new AccountAccessError(503, 'ONCHAIN_NOT_CONFIGURED', 'onchain support payments are not configured on this deployment');
  }
  return config;
}

export type OnchainRateLimitKind = 'intent' | 'verify';

/** Per-tenant limits: 10 intent creations and 6 verifications per minute. */
export async function enforceOnchainRateLimit(context: TenantContext, kind: OnchainRateLimitKind): Promise<void> {
  requireConfig();
  const tenant = context.organizationId ?? requireUser(context);
  const limit = kind === 'intent' ? { capacity: 10, refillPerMinute: 10 } : { capacity: 6, refillPerMinute: 6 };
  const result = await rateLimit(`onchain:${kind}:${tenant}`, limit);
  if (!result.allowed) {
    throw new AccountAccessError(429, 'RATE_LIMITED', `too many onchain ${kind} requests; retry after ${result.retryAfterSec}s`);
  }
}

function requireUser(context: TenantContext): string {
  if (!context.userId) throw new AccountAccessError(401, 'AUTH_REQUIRED', 'a verified account is required for billing');
  return context.userId;
}

function intentInScope(intent: { organizationId: string | null; ownerId: string | null }, context: TenantContext): boolean {
  if (context.organizationId) return intent.organizationId === context.organizationId;
  return context.userId !== null && intent.organizationId === null && intent.ownerId === context.userId;
}

/** Convert USD minor units into token base units exactly. No floating point, no rounding. */
export function quoteOnchainAmountUnits(amountMinor: number, tokenDecimals: number): string {
  if (!Number.isInteger(amountMinor) || amountMinor < ONCHAIN_MIN_AMOUNT_MINOR || amountMinor > ONCHAIN_MAX_AMOUNT_MINOR) {
    throw new AccountAccessError(
      400,
      'INVALID_AMOUNT',
      `support amount must be an integer between ${ONCHAIN_MIN_AMOUNT_MINOR} and ${ONCHAIN_MAX_AMOUNT_MINOR} USD minor units`,
    );
  }
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new AccountAccessError(500, 'INVALID_TOKEN_DECIMALS', 'configured token decimals are invalid');
  }
  const scale = 10n ** BigInt(tokenDecimals);
  const numerator = BigInt(amountMinor) * scale;
  if (numerator % 100n !== 0n) {
    throw new AccountAccessError(400, 'AMOUNT_GRANULARITY', 'support amount cannot be represented exactly in the configured token');
  }
  return (numerator / 100n).toString();
}

function newMemo(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

const intentInclude = {
  payments: { orderBy: { verifiedAt: 'desc' }, take: 1 },
} satisfies Prisma.OnchainPaymentIntentInclude;

export type OnchainIntentRecord = Prisma.OnchainPaymentIntentGetPayload<{ include: typeof intentInclude }>;
type OnchainPaymentRecord = Prisma.OnchainPaymentGetPayload<Record<string, never>>;

/** JSON-safe payment projection (BigInt block numbers must not reach NextResponse.json). */
export interface OnchainPaymentView {
  id: string;
  intentId: string;
  chainId: number;
  txHash: string;
  fromAddress: string;
  tokenAddress: string;
  amountUnits: string;
  confirmations: number;
  blockNumber: string | null;
  verifiedAt: string;
}

export function onchainPaymentView(payment: OnchainPaymentRecord): OnchainPaymentView {
  return {
    id: payment.id,
    intentId: payment.intentId,
    chainId: payment.chainId,
    txHash: payment.txHash,
    fromAddress: payment.fromAddress,
    tokenAddress: payment.tokenAddress,
    amountUnits: payment.amountUnits,
    confirmations: payment.confirmations,
    blockNumber: payment.blockNumber === null ? null : payment.blockNumber.toString(),
    verifiedAt: payment.verifiedAt.toISOString(),
  };
}

export interface OnchainIntentView {
  id: string;
  invoiceId: string | null;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  treasuryAddress: string;
  amountUnits: string;
  memo: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  payment: OnchainPaymentView | null;
  paymentNote: string;
}

export function onchainIntentView(intent: OnchainIntentRecord): OnchainIntentView {
  const expired = intent.status === 'open' && intent.expiresAt.getTime() <= Date.now();
  const payment = intent.payments[0];
  return {
    id: intent.id,
    invoiceId: intent.invoiceId,
    chainId: intent.chainId,
    tokenAddress: intent.tokenAddress,
    tokenSymbol: intent.tokenSymbol,
    tokenDecimals: intent.tokenDecimals,
    treasuryAddress: intent.treasuryAddress,
    amountUnits: intent.amountUnits,
    memo: intent.memo,
    status: expired ? 'expired' : intent.status,
    createdAt: intent.createdAt.toISOString(),
    expiresAt: intent.expiresAt.toISOString(),
    paidAt: intent.paidAt?.toISOString() ?? null,
    payment: payment ? onchainPaymentView(payment) : null,
    paymentNote: ONCHAIN_PAYMENT_NOTE,
  };
}

export interface CreateOnchainIntentInput {
  amountMinor: number;
  invoiceId?: string;
}

/** Create a 30-minute support intent. Never modifies entitlements. */
export async function createOnchainIntent(context: TenantContext, input: CreateOnchainIntentInput): Promise<OnchainIntentView> {
  const config = requireConfig();
  const userId = requireUser(context);
  if (input.invoiceId && !context.isPlatformAdmin) {
    throw new AccountAccessError(
      403,
      'ONCHAIN_INVOICE_LINK_ADMIN_ONLY',
      'support intents cannot be linked to invoices; invoice settlement is an administrator-only subscription action',
    );
  }
  const amountUnits = quoteOnchainAmountUnits(input.amountMinor, config.tokenDecimals!);
  const scope = context.organizationId ? { organizationId: context.organizationId } : { ownerId: userId, organizationId: null };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const intent = await db.$transaction(async (tx) => {
        // Opportunistic pruning keeps the tenant's open list honest without a separate cron.
        await tx.onchainPaymentIntent.updateMany({
          where: { ...scope, status: 'open', expiresAt: { lte: new Date() } },
          data: { status: 'expired' },
        });
        if (input.invoiceId) {
          const invoice = await tx.invoice.findFirst({
            where: { id: input.invoiceId, ...scope },
            select: { id: true, amountMinor: true, status: true },
          });
          if (!invoice) throw new AccountAccessError(404, 'INVOICE_NOT_FOUND', 'invoice not found');
          if (invoice.status !== 'open') {
            throw new AccountAccessError(409, 'INVOICE_NOT_OPEN', `invoice is ${invoice.status}; only open invoices can be supported`);
          }
          if (invoice.amountMinor !== input.amountMinor) {
            throw new AccountAccessError(409, 'AMOUNT_MISMATCH', `support amount must equal the invoice total of ${invoice.amountMinor} minor units`);
          }
        }
        const createdAt = new Date();
        const created = await tx.onchainPaymentIntent.create({
          data: {
            organizationId: context.organizationId,
            ownerId: context.organizationId ? null : userId,
            invoiceId: input.invoiceId ?? null,
            chainId: config.chainId!,
            tokenAddress: config.tokenAddress!,
            tokenSymbol: config.tokenSymbol!,
            tokenDecimals: config.tokenDecimals!,
            treasuryAddress: config.treasuryAddress!,
            amountUnits,
            memo: newMemo(),
            status: 'open',
            createdAt,
            expiresAt: new Date(createdAt.getTime() + ONCHAIN_INTENT_TTL_MS),
          },
          include: intentInclude,
        });
        await writeMutationEffects(tx, {
          actor: `account:${userId}`,
          action: 'billing.onchain.intent.create',
          targetId: created.id,
          detail: `${amountUnits} ${config.tokenSymbol} units on chain ${config.chainId}`,
          organizationId: context.organizationId,
          aggregateType: 'OnchainPaymentIntent',
          aggregateId: created.id,
          eventType: 'onchain.intent.created',
          payload: {
            intentId: created.id,
            invoiceId: created.invoiceId,
            chainId: created.chainId,
            tokenAddress: created.tokenAddress,
            amountUnits: created.amountUnits,
            memo: created.memo,
            expiresAt: created.expiresAt,
          },
        });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
      return onchainIntentView(intent);
    } catch (error) {
      if (errorCode(error) === 'P2002' && attempt < 2) continue; // memo collision
      throw error;
    }
  }
  throw new Error('onchain intent memo retry exhausted');
}

/** Read one intent within the caller's tenant scope. */
export async function getOnchainIntent(context: TenantContext, intentId: string): Promise<OnchainIntentView> {
  requireUser(context);
  const intent = await db.onchainPaymentIntent.findUnique({ where: { id: intentId }, include: intentInclude });
  if (!intent || !intentInScope(intent, context)) {
    throw new AccountAccessError(404, 'ONCHAIN_INTENT_NOT_FOUND', 'onchain payment intent not found');
  }
  return onchainIntentView(intent);
}

function hexToBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  throw new AccountAccessError(502, 'ONCHAIN_RPC_INVALID', `RPC returned an invalid ${field}`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new AccountAccessError(502, 'ONCHAIN_RPC_INVALID', 'RPC returned an invalid address');
  }
  return value.toLowerCase();
}

/** A malformed log value is simply not a match; it is not an RPC outage. */
function tryLogAmount(value: unknown): bigint | null {
  try {
    return hexToBigInt(value, 'log amount');
  } catch {
    return null;
  }
}

async function rpcCall(config: OnchainConfig, method: string, params: unknown[]): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(config.rpcUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AccountAccessError(502, 'ONCHAIN_RPC_UNAVAILABLE', 'the chain RPC endpoint is unreachable');
  }
  if (!response.ok) throw new AccountAccessError(502, 'ONCHAIN_RPC_UNAVAILABLE', `the chain RPC endpoint returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccountAccessError(502, 'ONCHAIN_RPC_INVALID', 'the chain RPC returned a malformed response');
  }
  const body = payload as { result?: unknown; error?: { message?: unknown } };
  if (body.error) throw new AccountAccessError(502, 'ONCHAIN_RPC_ERROR', 'the chain RPC rejected the request');
  return body.result;
}

interface VerifiedOnchainTransfer {
  fromAddress: string;
  blockNumber: bigint;
  confirmations: number;
}

interface RpcLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  transactionHash?: unknown;
}

/** Verify receipt success, chain id, exact transfer semantics, and confirmation depth. */
async function verifyTransaction(
  config: OnchainConfig,
  intent: { tokenAddress: string; treasuryAddress: string; amountUnits: string; memo: string },
  txHash: string,
  requiredConfirmations: number,
): Promise<VerifiedOnchainTransfer> {
  const receipt = await rpcCall(config, 'eth_getTransactionReceipt', [txHash]) as Record<string, unknown> | null;
  if (!receipt || typeof receipt !== 'object') {
    throw new AccountAccessError(409, 'ONCHAIN_TX_NOT_FOUND', 'the transaction is not visible on the configured chain');
  }
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== txHash) {
    throw new AccountAccessError(409, 'ONCHAIN_TX_NOT_FOUND', 'the RPC receipt does not match the supplied transaction hash');
  }
  const observedChainId = hexToBigInt(await rpcCall(config, 'eth_chainId', []), 'chain id');
  if (observedChainId !== BigInt(config.chainId!)) {
    throw new AccountAccessError(409, 'ONCHAIN_CHAIN_MISMATCH', 'the RPC endpoint reports a different chain id than the configured chain');
  }
  if (hexToBigInt(receipt.status, 'receipt status') !== 1n) {
    throw new AccountAccessError(409, 'ONCHAIN_TX_REVERTED', 'the transaction reverted');
  }
  const blockNumber = hexToBigInt(receipt.blockNumber, 'block number');
  if (blockNumber <= 0n) throw new AccountAccessError(409, 'ONCHAIN_TX_NOT_FOUND', 'the transaction is not yet mined');
  const latestBlock = hexToBigInt(await rpcCall(config, 'eth_blockNumber', []), 'latest block');
  const confirmations = Number(latestBlock - blockNumber + 1n);
  if (confirmations < requiredConfirmations) {
    throw new AccountAccessError(
      409,
      'ONCHAIN_INSUFFICIENT_CONFIRMATIONS',
      `transaction has ${Math.max(confirmations, 0)} confirmation${confirmations === 1 ? '' : 's'}; ${requiredConfirmations} required`,
    );
  }
  const fromAddress = normalizeAddress(receipt.from);
  const treasury = intent.treasuryAddress.toLowerCase();
  const expectedAmount = BigInt(intent.amountUnits);
  const rawLogs: unknown[] = Array.isArray(receipt.logs) ? receipt.logs : [];
  const logs = rawLogs.filter((value): value is RpcLog => typeof value === 'object' && value !== null && 'topics' in value);

  if (intent.tokenAddress === NATIVE_TOKEN) {
    const tx = await rpcCall(config, 'eth_getTransactionByHash', [txHash]) as Record<string, unknown> | null;
    if (!tx || typeof tx !== 'object') throw new AccountAccessError(409, 'ONCHAIN_TX_NOT_FOUND', 'the native transaction is not visible');
    const to = typeof tx.to === 'string' ? normalizeAddress(tx.to) : null;
    const value = hexToBigInt(tx.value ?? '0x0', 'transaction value');
    if (to === treasury) {
      if (value !== expectedAmount) {
        throw new AccountAccessError(409, 'ONCHAIN_AMOUNT_MISMATCH', 'the native payment value does not exactly match the intent');
      }
      return { fromAddress, blockNumber, confirmations };
    }
    const supportContract = config.supportContractAddress?.toLowerCase() ?? null;
    if (to !== null && supportContract !== null && to === supportContract) {
      // The forwarding contract emits Support only after the treasury transfer
      // succeeds. Accept it when the event matches token/amount/memo.
      if (value !== expectedAmount) {
        throw new AccountAccessError(409, 'ONCHAIN_AMOUNT_MISMATCH', 'the native payment value does not exactly match the intent');
      }
      const supportLog = logs.find((log) => {
        const topics = Array.isArray(log.topics) ? log.topics : [];
        if (typeof log.address !== 'string' || log.address.toLowerCase() !== supportContract) return false;
        if (typeof topics[0] !== 'string' || topics[0].toLowerCase() !== SUPPORT_EVENT_TOPIC) return false;
        const tokenTopic = typeof topics[2] === 'string' ? topics[2].toLowerCase() : null;
        const memoTopic = typeof topics[3] === 'string' ? topics[3].toLowerCase() : null;
        if (tokenTopic !== ZERO_ADDRESS_TOPIC || memoTopic !== intent.memo.toLowerCase()) return false;
        if (typeof topics[1] !== 'string' || topics[1].length !== 66) return false;
        return tryLogAmount(log.data) === expectedAmount;
      });
      if (!supportLog) {
        throw new AccountAccessError(409, 'ONCHAIN_NATIVE_EVENT_MISMATCH', 'the support contract event does not match the intent');
      }
      const payerTopic = Array.isArray(supportLog.topics) && typeof supportLog.topics[1] === 'string' ? supportLog.topics[1] : null;
      const eventPayer = payerTopic && payerTopic.length === 66 ? `0x${payerTopic.slice(-40)}`.toLowerCase() : fromAddress;
      return { fromAddress: eventPayer, blockNumber, confirmations };
    }
    throw new AccountAccessError(409, 'ONCHAIN_RECIPIENT_MISMATCH', 'the native payment was not sent to the configured treasury');
  }

  const tokenAddress = intent.tokenAddress.toLowerCase();
  const transferLogs = logs.filter((log) => {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    return typeof log.address === 'string'
      && log.address.toLowerCase() === tokenAddress
      && typeof topics[0] === 'string'
      && topics[0].toLowerCase() === TRANSFER_TOPIC;
  });
  if (transferLogs.length === 0) {
    throw new AccountAccessError(409, 'ONCHAIN_TOKEN_MISMATCH', 'no Transfer log for the configured token was found');
  }
  const toTreasury = transferLogs.filter((log) => {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const toTopic = typeof topics[2] === 'string' ? topics[2] : null;
    if (!toTopic || toTopic.length !== 66) return false;
    return `0x${toTopic.slice(-40)}`.toLowerCase() === treasury;
  });
  if (toTreasury.length === 0) {
    throw new AccountAccessError(409, 'ONCHAIN_RECIPIENT_MISMATCH', 'the token transfer did not go to the configured treasury');
  }
  const exact = toTreasury.find((log) => {
    if (typeof log.data !== 'string') return false;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const logHash = typeof log.transactionHash === 'string' ? log.transactionHash.toLowerCase() : txHash;
    const fromTopic = typeof topics[1] === 'string' ? topics[1] : null;
    return logHash === txHash
      && fromTopic !== null
      && fromTopic.length === 66
      && fromTopic !== ZERO_ADDRESS_TOPIC
      && tryLogAmount(log.data) === expectedAmount;
  });
  if (!exact) {
    throw new AccountAccessError(409, 'ONCHAIN_AMOUNT_MISMATCH', 'the token transfer amount does not exactly match the intent');
  }
  return { fromAddress, blockNumber, confirmations };
}

export interface VerifyOnchainIntentResult {
  intent: OnchainIntentView;
  payment: OnchainPaymentView;
}

/**
 * Verify a transaction and record it exactly once. The pre-RPC intent lookup
 * uses the owner connection because verification starts before a tenant
 * transaction exists; every write then runs on the tenant-scoped connection
 * with an explicit scope re-check. The unique constraints on
 * OnchainPayment(intentId) and OnchainPayment(txHash) are the final concurrency gate.
 */
export async function verifyOnchainIntent(context: TenantContext, intentId: string, txHashInput: string): Promise<VerifyOnchainIntentResult> {
  const config = requireConfig();
  const userId = requireUser(context);
  const txHash = txHashInput.trim().toLowerCase();
  if (!TX_HASH_PATTERN.test(txHash)) throw new AccountAccessError(400, 'INVALID_TX_HASH', 'txHash must be a 0x-prefixed 32-byte hash');

  const preflight = await rawDb.onchainPaymentIntent.findUnique({ where: { id: intentId } });
  if (!preflight || !intentInScope(preflight, context)) {
    throw new AccountAccessError(404, 'ONCHAIN_INTENT_NOT_FOUND', 'onchain payment intent not found');
  }
  if (preflight.status === 'paid') throw new AccountAccessError(409, 'INTENT_ALREADY_PAID', 'this intent has already been paid');
  if (preflight.status === 'expired' || preflight.expiresAt.getTime() <= Date.now()) {
    throw new AccountAccessError(409, 'INTENT_EXPIRED', 'this intent has expired; create a new support intent');
  }
  if (preflight.chainId !== config.chainId) {
    throw new AccountAccessError(409, 'ONCHAIN_CHAIN_MISMATCH', 'the intent was created for a different chain than the active configuration');
  }
  if (preflight.tokenAddress.toLowerCase() !== config.tokenAddress!.toLowerCase() || preflight.tokenDecimals !== config.tokenDecimals) {
    throw new AccountAccessError(409, 'ONCHAIN_TOKEN_MISMATCH', 'the intent was created for a different token than the active configuration');
  }
  if (preflight.treasuryAddress.toLowerCase() !== config.treasuryAddress!.toLowerCase()) {
    throw new AccountAccessError(409, 'ONCHAIN_RECIPIENT_MISMATCH', 'the intent treasury no longer matches the active configuration');
  }
  const reused = await rawDb.onchainPayment.findUnique({ where: { txHash } });
  if (reused) throw new AccountAccessError(409, 'TX_ALREADY_USED', 'this transaction hash has already been verified');
  if (preflight.invoiceId && !context.isPlatformAdmin) {
    throw new AccountAccessError(403, 'ONCHAIN_INVOICE_LINK_ADMIN_ONLY', 'invoice-linked settlement can be verified only by a platform administrator');
  }

  const requiredConfirmations = preflight.invoiceId
    ? Math.max(config.confirmations, ONCHAIN_INVOICE_MIN_CONFIRMATIONS)
    : config.confirmations;
  const observed = await verifyTransaction(config, preflight, txHash, requiredConfirmations);

  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.onchainPaymentIntent.findUnique({ where: { id: intentId } });
      if (!current || !intentInScope(current, context)) {
        throw new AccountAccessError(404, 'ONCHAIN_INTENT_NOT_FOUND', 'onchain payment intent not found');
      }
      if (current.status === 'paid') throw new AccountAccessError(409, 'INTENT_ALREADY_PAID', 'this intent has already been paid');
      if (current.status === 'expired' || current.expiresAt.getTime() <= Date.now()) {
        throw new AccountAccessError(409, 'INTENT_EXPIRED', 'this intent has expired; create a new support intent');
      }
      if (current.invoiceId && !context.isPlatformAdmin) {
        throw new AccountAccessError(403, 'ONCHAIN_INVOICE_LINK_ADMIN_ONLY', 'invoice-linked settlement can be verified only by a platform administrator');
      }

      const payment = await tx.onchainPayment.create({
        data: {
          intentId: current.id,
          chainId: current.chainId,
          txHash,
          fromAddress: observed.fromAddress,
          tokenAddress: current.tokenAddress,
          amountUnits: current.amountUnits,
          confirmations: observed.confirmations,
          blockNumber: observed.blockNumber,
          verifiedAt: new Date(),
        },
      });
      const now = new Date();
      const updated = await tx.onchainPaymentIntent.update({
        where: { id: current.id },
        data: { status: 'paid', paidAt: now },
        include: intentInclude,
      });

      if (current.invoiceId) {
        await settleVerifiedOnchainInvoiceInTransaction(tx, context, current.invoiceId, txHash);
      }

      await writeMutationEffects(tx, {
        actor: `account:${userId}`,
        action: 'billing.onchain.verify',
        targetId: current.id,
        detail: `${txHash} · ${current.amountUnits} ${current.tokenSymbol} units`,
        organizationId: current.organizationId,
        aggregateType: 'OnchainPayment',
        aggregateId: payment.id,
        eventType: 'onchain.payment.verified',
        payload: {
          intentId: current.id,
          paymentId: payment.id,
          txHash,
          chainId: current.chainId,
          tokenAddress: current.tokenAddress,
          amountUnits: current.amountUnits,
          confirmations: observed.confirmations,
          blockNumber: observed.blockNumber.toString(),
          invoiceId: current.invoiceId,
          fromAddress: observed.fromAddress,
        },
      });

      return { intent: onchainIntentView(updated), payment: onchainPaymentView(payment) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'P2002' || code === 'P2034') {
      throw new AccountAccessError(409, 'ONCHAIN_PAYMENT_CONFLICT', 'this intent or transaction hash has already been verified');
    }
    throw error;
  }
}
