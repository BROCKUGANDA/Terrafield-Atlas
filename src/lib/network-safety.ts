import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface IpAddressVerdict {
  ok: boolean;
  reason?: string;
}

const MAX_IPV4 = (1n << 32n) - 1n;

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  let text = value;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/i.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const parts = [...left, ...Array<string>(missing).fill('0'), ...right];
  return parts.reduce((address, part) => (address << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function inPrefix(address: bigint, prefix: bigint, bits: number, width: 32 | 128): boolean {
  const shift = BigInt(width - bits);
  return (address >> shift) === (prefix >> shift);
}

function classifyIpv4(address: bigint): IpAddressVerdict {
  const a = Number((address >> 24n) & 0xffn);
  const b = Number((address >> 16n) & 0xffn);
  const ranges: Array<{ prefix: bigint; bits: number; label: string }> = [
    { prefix: 0n, bits: 8, label: 'this-network 0.0.0.0/8' },
    { prefix: 10n << 24n, bits: 8, label: 'RFC1918 10.0.0.0/8' },
    { prefix: 127n << 24n, bits: 8, label: 'loopback 127.0.0.0/8' },
    { prefix: 169n << 24n | 254n << 16n, bits: 16, label: 'link-local 169.254.0.0/16 (cloud metadata included)' },
    { prefix: 172n << 24n | 16n << 16n, bits: 12, label: 'RFC1918 172.16.0.0/12' },
    { prefix: 192n << 24n | 168n << 16n, bits: 16, label: 'RFC1918 192.168.0.0/16' },
    { prefix: 100n << 24n | 64n << 16n, bits: 10, label: 'CGNAT 100.64.0.0/10' },
    { prefix: 192n << 24n | 0n << 16n, bits: 24, label: 'IETF protocol assignments 192.0.0.0/24' },
    { prefix: 192n << 24n | 0n << 16n | 2n << 8n, bits: 24, label: 'documentation 192.0.2.0/24' },
    { prefix: 198n << 24n | 18n << 16n, bits: 15, label: 'benchmarking 198.18.0.0/15' },
    { prefix: 198n << 24n | 51n << 16n | 100n << 8n, bits: 24, label: 'documentation 198.51.100.0/24' },
    { prefix: 203n << 24n | 0n << 16n | 113n << 8n, bits: 24, label: 'documentation 203.0.113.0/24' },
    { prefix: 224n << 24n, bits: 4, label: 'multicast 224.0.0.0/4' },
    { prefix: 240n << 24n, bits: 4, label: 'reserved 240.0.0.0/4' },
  ];
  if (address === MAX_IPV4) return { ok: false, reason: 'broadcast 255.255.255.255/32' };
  for (const range of ranges) {
    if (inPrefix(address, range.prefix, range.bits, 32)) return { ok: false, reason: range.label };
  }
  // Kept explicit so future range edits cannot accidentally admit class-E space.
  if (a >= 224) return { ok: false, reason: 'non-global IPv4 address' };
  if (b === 0 && (a === 192 || a === 198)) return { ok: false, reason: 'non-global IPv4 address' };
  return { ok: true };
}

function classifyIpv6(address: bigint): IpAddressVerdict {
  const mapped = inPrefix(address, 0n, 96, 128);
  const compatible = address <= MAX_IPV4;
  if (mapped || compatible) return classifyIpv4(address & MAX_IPV4);
  if (inPrefix(address, parseIpv6('64:ff9b::')!, 96, 128)) return { ok: false, reason: 'NAT64 64:ff9b::/96' };
  if (inPrefix(address, parseIpv6('64:ff9b:1::')!, 48, 128)) return { ok: false, reason: 'local-use NAT64 64:ff9b:1::/48' };
  if (inPrefix(address, parseIpv6('2002::')!, 16, 128)) return { ok: false, reason: '6to4 2002::/16' };
  if (inPrefix(address, parseIpv6('2001::')!, 32, 128)) return { ok: false, reason: 'Teredo 2001::/32' };
  if (inPrefix(address, parseIpv6('ff00::')!, 8, 128)) return { ok: false, reason: 'multicast ff00::/8' };
  if (inPrefix(address, parseIpv6('fe80::')!, 10, 128)) return { ok: false, reason: 'link-local fe80::/10' };
  if (inPrefix(address, parseIpv6('fc00::')!, 7, 128)) return { ok: false, reason: 'unique-local fc00::/7' };
  if (inPrefix(address, parseIpv6('fec0::')!, 10, 128)) return { ok: false, reason: 'deprecated site-local fec0::/10' };
  if (inPrefix(address, parseIpv6('2001:db8::')!, 32, 128)) return { ok: false, reason: 'documentation 2001:db8::/32' };
  if (inPrefix(address, parseIpv6('2001:2::')!, 48, 128)) return { ok: false, reason: 'benchmarking 2001:2::/48' };
  if (inPrefix(address, parseIpv6('100::')!, 64, 128)) return { ok: false, reason: 'discard-only 100::/64' };
  if (!inPrefix(address, parseIpv6('2000::')!, 3, 128)) return { ok: false, reason: 'non-global IPv6 address' };
  return { ok: true };
}

/** Returns null for hostnames; literals are parsed and classified without DNS. */
export function classifyIpLiteral(value: string): IpAddressVerdict | null {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) return classifyIpv4(parseIpv4(host)!);
  if (family === 6) return classifyIpv6(parseIpv6(host)!);
  return null;
}

export interface PinnedTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export type PublicTargetResult = { ok: true; target: PinnedTarget } | { ok: false; reason: string };
export type PublicAddressResolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

export function assertPublicUrl(rawUrl: string): IpAddressVerdict {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: 'unparseable URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} refused` };
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { ok: false, reason: 'empty hostname' };
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { ok: false, reason: 'loopback/internal-only hostname' };
  }
  const literal = classifyIpLiteral(hostname);
  return literal ?? { ok: true };
}

export async function resolvePinnedTarget(rawUrl: string, resolver: PublicAddressResolver = dnsLookup, allowPrivate = false): Promise<PublicTargetResult> {
  if (!allowPrivate) return resolvePublicTarget(rawUrl, resolver);
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: 'unparseable URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} refused` };
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { ok: false, reason: 'empty hostname' };
  if (isIP(hostname)) return { ok: true, target: { url, hostname, address: hostname, family: isIP(hostname) as 4 | 6 } };
  let answers: Array<{ address: string; family: number }>;
  try { answers = await resolver(hostname, { all: true, verbatim: true }); } catch { return { ok: false, reason: 'target hostname did not resolve' }; }
  if (answers.length === 0) return { ok: false, reason: 'target hostname has no addresses' };
  for (const answer of answers) if (!isIP(answer.address)) return { ok: false, reason: 'resolved address is invalid' };
  const selected = answers[0];
  const family = isIP(selected.address);
  if (family !== 4 && family !== 6) return { ok: false, reason: 'resolved address is invalid' };
  return { ok: true, target: { url, hostname, address: selected.address, family } };
}

export async function resolvePublicTarget(rawUrl: string, resolver: PublicAddressResolver = dnsLookup): Promise<PublicTargetResult> {
  const safe = assertPublicUrl(rawUrl);
  if (!safe.ok) return { ok: false, reason: safe.reason ?? 'unsafe target' };
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(hostname)) {
    return { ok: true, target: { url, hostname, address: hostname, family: isIP(hostname) as 4 | 6 } };
  }
  let answers: Array<{ address: string; family: number }>;
  try { answers = await resolver(hostname, { all: true, verbatim: true }); } catch { return { ok: false, reason: 'target hostname did not resolve' }; }
  if (answers.length === 0) return { ok: false, reason: 'target hostname has no addresses' };
  for (const answer of answers) {
    const verdict = classifyIpLiteral(answer.address);
    if (!verdict?.ok) return { ok: false, reason: `resolved address refused: ${verdict?.reason ?? 'invalid address'}` };
  }
  const selected = answers[0];
  const family = isIP(selected.address);
  if (family !== 4 && family !== 6) return { ok: false, reason: 'resolved address is invalid' };
  return { ok: true, target: { url, hostname, address: selected.address, family } };
}

export function createPinnedLookup(target: PinnedTarget): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    if ((options as { all?: boolean } | undefined)?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as LookupFunction;
}

export interface PinnedFetchOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolver?: PublicAddressResolver;
  allowPrivate?: boolean;
}

/** No redirects and no second DNS lookup: the socket uses only a validated address. */
export async function fetchPinnedPublicUrl(rawUrl: string, options: PinnedFetchOptions = {}): Promise<Response> {
  const resolved = await resolvePinnedTarget(rawUrl, options.resolver, options.allowPrivate ?? false);
  if (!resolved.ok) throw new Error(`SSRF guard refused target: ${resolved.reason}`);
  const { target } = resolved;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 20_000);
  const maxBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  try {
    return await new Promise<Response>((resolve, reject) => {
      const headers = new Headers(options.headers);
      if (!headers.has('host')) headers.set('host', target.url.host);
      if (options.body !== undefined && !headers.has('content-length')) headers.set('content-length', String(typeof options.body === 'string' ? Buffer.byteLength(options.body) : options.body.byteLength));
      const transport = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const auth = target.url.username || target.url.password
        ? `${decodeURIComponent(target.url.username)}:${decodeURIComponent(target.url.password)}`
        : undefined;
      const request = transport(target.url, {
        method: options.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        lookup: createPinnedLookup(target),
        servername: target.url.protocol === 'https:' && !isIP(target.hostname) ? target.hostname : undefined,
        auth,
        signal: controller.signal,
      }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          fail(new Error(`response exceeds ${maxBytes} bytes`));
          response.destroy();
          return;
        }
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > maxBytes) {
            fail(new Error(`response exceeds ${maxBytes} bytes`));
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = response.statusCode ?? 502;
          const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders }));
        });
        response.on('error', fail);
      });
      request.on('error', reject);
      if (options.body !== undefined) request.write(options.body);
      request.end();
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
