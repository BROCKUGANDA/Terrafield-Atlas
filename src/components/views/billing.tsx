'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Coins, Copy, CreditCard, Gauge, Receipt, ShieldCheck } from 'lucide-react';
import { api, ApiRequestError, type BillingPlan } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { logEvent } from '@/components/state/log-store';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { HudPanel, SectionHeader, StatusPill, TelemetryStat } from '@/components/ui-mc/kit';
import { FaultPanel } from '@/components/system/query-state';
import { useOrganizationStore } from '@/components/state/organization-store';
import { ApiKeysPanel } from '@/components/api-keys-panel';
import { WebhooksPanel } from '@/components/webhooks-panel';

const METRIC_LABELS: Record<string, string> = {
  farms: 'Managed farms',
  processing_jobs_per_month: 'Processing jobs / month',
  api_requests_per_day: 'API requests / day',
  reports_per_month: 'Reports / month',
  ai_runs_per_month: 'Intelligence runs / month',
  storage_mb: 'Storage (MB)',
};

function formatPrice(plan: BillingPlan): string {
  if (plan.code === 'institutional') return 'Custom';
  if (plan.monthlyPriceMinor === 0) return 'Free';
  return `${(plan.monthlyPriceMinor / 100).toFixed(2)} ${plan.currency}/mo`;
}

interface InvoicePaymentRow {
  id: string;
  amountMinor: number;
  currency: string;
  method: string;
  status: string;
  reference: string | null;
  createdAt: string;
}

interface InvoiceRow {
  id: string;
  number: string;
  status: string;
  amountMinor: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string;
  paidAt: string | null;
  payments: InvoicePaymentRow[];
}

interface InvoiceListResponse {
  invoices: InvoiceRow[];
  count: number;
  paymentNote: string;
}

interface InvoiceIssueResponse {
  invoice: InvoiceRow;
  created: boolean;
}

interface InvoiceSettleResponse {
  invoice: InvoiceRow;
}

function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function formatPeriod(invoice: InvoiceRow): string {
  if (!invoice.periodStart) return 'One-off charge';
  const start = invoice.periodStart.slice(0, 10);
  const end = invoice.periodEnd ? invoice.periodEnd.slice(0, 10) : '—';
  return `${start} → ${end}`;
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = payload.error;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  }
  return `HTTP ${status}`;
}

/** Billing views use plain fetch so invoice settlement stays independent of the shared api-client. */
async function billingRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const organizationId = useOrganizationStore.getState().activeOrganizationId;
  if (organizationId) headers.set('x-terrafield-organization', organizationId);
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('idempotency-key')) headers.set('idempotency-key', crypto.randomUUID());
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('The billing API returned a malformed response.');
    }
  }
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
  return payload as T;
}

interface OnchainConfigResponse {
  enabled: boolean;
  chainId: number | null;
  treasuryAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  native: boolean;
  confirmations: number;
  expiresMinutes: number;
  minAmountMinor: number;
  maxAmountMinor: number;
  missing: string[];
  paymentNote: string;
}

interface OnchainPaymentRow {
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

interface OnchainIntentRow {
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
  payment: OnchainPaymentRow | null;
  paymentNote: string;
}

const ONCHAIN_PRESETS = [500, 1000, 2500, 5000];

function formatTokenUnits(units: string, decimals: number): string {
  try {
    const value = BigInt(units);
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 8);
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return units;
  }
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function OnchainSupportCard() {
  const { toast } = useToast();
  const config = useQuery({
    queryKey: ['billing-onchain-config'],
    queryFn: () => billingRequest<OnchainConfigResponse>('/api/v1/billing/onchain/config'),
    retry: 1,
  });
  const [amountInput, setAmountInput] = useState('10.00');
  const [intent, setIntent] = useState<OnchainIntentRow | null>(null);
  const [txHash, setTxHash] = useState('');
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const create = useMutation({
    mutationFn: (amount: number) => billingRequest<{ intent: OnchainIntentRow }>('/api/v1/billing/onchain/intents', {
      method: 'POST',
      body: JSON.stringify({ amountMinor: amount }),
    }),
    onSuccess: (result) => {
      setIntent(result.intent);
      setTxHash('');
      toast({ title: 'Support intent created', description: `Send exactly ${formatTokenUnits(result.intent.amountUnits, result.intent.tokenDecimals)} ${result.intent.tokenSymbol}. This does not change your plan or entitlements.` });
    },
    onError: (error) => toast({ title: 'Could not create intent', description: error instanceof Error ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const verify = useMutation({
    mutationFn: (input: { intentId: string; hash: string }) => billingRequest<{ intent: OnchainIntentRow; payment: OnchainPaymentRow }>(`/api/v1/billing/onchain/intents/${input.intentId}/verify`, {
      method: 'POST',
      body: JSON.stringify({ txHash: input.hash }),
    }),
    onSuccess: (result) => {
      setIntent(result.intent);
      setTxHash('');
      toast({ title: 'Support payment verified', description: 'Recorded from the public chain. Your entitlements are unchanged.' });
      logEvent({ severity: 'success', category: 'SYSTEM', title: 'Onchain support verified', detail: `${result.payment.txHash} · ${formatTokenUnits(result.payment.amountUnits, result.intent.tokenDecimals)} ${result.intent.tokenSymbol} · ${result.payment.confirmations} confirmations. Voluntary support only.`, view: 'billing' });
    },
    onError: (error) => toast({ title: 'Verification rejected', description: error instanceof Error ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied` });
    } catch {
      toast({ title: 'Copy failed', description: 'Select and copy the value manually.', variant: 'destructive' });
    }
  };

  if (config.isError) return <FaultPanel error={config.error} onRetry={() => config.refetch()} label="Onchain support configuration" />;
  const data = config.data;
  const decimals = intent?.tokenDecimals ?? data?.tokenDecimals ?? 6;
  const symbol = intent?.tokenSymbol ?? data?.tokenSymbol ?? 'USDC';
  const presets = ONCHAIN_PRESETS.filter((value) => value >= (data?.minAmountMinor ?? 100) && value <= (data?.maxAmountMinor ?? 1_000_000));
  const effectiveStatus = intent && intent.status === 'open' && now > 0 && new Date(intent.expiresAt).getTime() <= now ? 'expired' : intent?.status;
  const displayStatus = effectiveStatus === 'open' ? 'pending' : effectiveStatus;
  const parsedAmountMinor = Math.round(Number(amountInput) * 100);
  const amountMinor = Number.isFinite(parsedAmountMinor) ? parsedAmountMinor : 0;
  const amountValid = Number.isFinite(parsedAmountMinor) && amountMinor >= (data?.minAmountMinor ?? 100) && amountMinor <= (data?.maxAmountMinor ?? 1_000_000);

  return (
    <HudPanel calm className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Coins className="h-4 w-4 text-signal" />
        <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Onchain support</h3>
        <StatusPill status={data?.enabled ? 'configured' : 'not configured'} pulse={false} />
      </div>
      <p className="max-w-3xl text-[11px] leading-relaxed text-dim">
        Core TerraField features stay free. Onchain support is voluntary and does not unlock or lock anything. It is not a card or fiat payment, and paying it never changes your plan, quotas, or access.
      </p>

      {!data && <p className="text-[11px] text-faint">Reading onchain support configuration…</p>}
      {data && !data.enabled && (
        <div className="rounded-sm border border-edge bg-panel-2/50 p-3">
          <p className="text-[11px] leading-relaxed text-dim">
            Onchain support is not configured on this deployment. Everything else in TerraField keeps working; no support payment can be created or verified here.
          </p>
        </div>
      )}

      {data?.enabled && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid gap-2">
            <p className="text-[11px] text-dim">Choose a voluntary amount ({symbol} on chain {data.chainId}). Minimum ${(data.minAmountMinor / 100).toFixed(2)}, maximum ${(data.maxAmountMinor / 100).toFixed(2)}.</p>
            <div className="flex flex-wrap gap-2">
              {presets.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={amountMinor === value ? 'default' : 'outline'}
                  className="h-8 font-mono text-[10px] uppercase tracking-wide-mc"
                  onClick={() => setAmountInput((value / 100).toFixed(2))}
                >
                  ${(value / 100).toFixed(0)}
                </Button>
              ))}
            </div>
            <Label className="grid max-w-[220px] gap-1 text-[10px] text-dim">
              Custom amount (USD)
              <Input
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                inputMode="decimal"
                className="border-edge bg-panel text-ink"
              />
            </Label>
            <Button
              className="h-9 w-fit font-mono text-[10px] uppercase tracking-wide-mc"
              onClick={() => create.mutate(amountMinor)}
              disabled={create.isPending || !amountValid}
            >
              {create.isPending ? 'Creating…' : `Create $${(amountMinor / 100).toFixed(2)} support intent`}
            </Button>
            <p className="telemetry text-[10px] text-faint">Intents expire after {data.expiresMinutes} minutes. Verification waits for {data.confirmations} confirmation{data.confirmations === 1 ? '' : 's'}.</p>
          </div>

          <div className="grid gap-2">
            {!intent && <p className="text-[11px] leading-relaxed text-dim">No active intent. Create one to get the exact amount, treasury address, and memo.</p>}
            {intent && (
              <div className="grid gap-2 rounded-sm border border-edge bg-panel-2/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={displayStatus ?? 'pending'} pulse={effectiveStatus === 'open'} />
                  <span className="font-mono text-sm text-ink">{formatTokenUnits(intent.amountUnits, decimals)} {symbol}</span>
                  <span className="telemetry text-[10px] text-faint">chain {intent.chainId}</span>
                  {intent.invoiceId && <span className="telemetry text-[10px] text-faint">invoice-linked</span>}
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[10px] text-faint">Recipient</span>
                    <code className="break-all font-mono text-[10px] text-ink">{intent.treasuryAddress}</code>
                    <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Copy treasury address" onClick={() => void copy('Treasury address', intent.treasuryAddress)}><Copy className="h-3 w-3" /></Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[10px] text-faint">Token</span>
                    <code className="break-all font-mono text-[10px] text-ink">{intent.tokenAddress === 'native' ? 'native (gas coin)' : intent.tokenAddress}</code>
                    {intent.tokenAddress !== 'native' && <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Copy token address" onClick={() => void copy('Token address', intent.tokenAddress)}><Copy className="h-3 w-3" /></Button>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[10px] text-faint">Memo</span>
                    <code className="break-all font-mono text-[10px] text-ink">{intent.memo}</code>
                    <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Copy memo" onClick={() => void copy('Memo', intent.memo)}><Copy className="h-3 w-3" /></Button>
                  </div>
                  <p className="telemetry text-[10px] text-faint">Expires {intent.expiresAt.slice(0, 16).replace('T', ' ')} UTC · intent {intent.id.slice(0, 10)}…</p>
                </div>
                <p className="text-[10px] leading-relaxed text-dim">
                  Send exactly this amount of {symbol} to the recipient on chain {intent.chainId}. Keep the memo as your reference. The server checks the public chain only after you paste the transaction hash; it never holds a key.
                </p>

                {effectiveStatus === 'paid' && intent.payment ? (
                  <div className="grid gap-1 border-t border-edge/60 pt-2">
                    <p className="text-[11px] text-signal">Verified · {intent.payment.confirmations} confirmation{intent.payment.confirmations === 1 ? '' : 's'} · from {shortAddress(intent.payment.fromAddress)}</p>
                    <code className="break-all font-mono text-[10px] text-dim">{intent.payment.txHash}</code>
                    <p className="text-[10px] text-faint">Thank you. This support did not change your plan or entitlements.</p>
                  </div>
                ) : (
                  <form
                    className="grid gap-2 border-t border-edge/60 pt-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!intent || effectiveStatus !== 'open') return;
                      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) {
                        toast({ title: 'Invalid transaction hash', description: 'Paste the 0x-prefixed 32-byte hash.', variant: 'destructive' });
                        return;
                      }
                      verify.mutate({ intentId: intent.id, hash: txHash.trim() });
                    }}
                  >
                    <Label className="grid gap-1 text-[10px] text-dim">
                      Transaction hash
                      <Input value={txHash} onChange={(event) => setTxHash(event.target.value)} placeholder="0x…" maxLength={66} className="border-edge bg-panel font-mono text-ink" />
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" className="h-8 font-mono text-[10px] uppercase tracking-wide-mc" disabled={verify.isPending || effectiveStatus !== 'open'}>
                        {verify.isPending ? 'Verifying…' : 'Verify support payment'}
                      </Button>
                      <Button type="button" variant="ghost" className="h-8 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => { setIntent(null); setTxHash(''); }}>
                        New intent
                      </Button>
                    </div>
                    {effectiveStatus === 'expired' && <p className="text-[10px] text-caution">This intent expired before verification. Create a fresh intent and send again; expired intents are never accepted.</p>}
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </HudPanel>
  );
}

export function BillingView() {
  const { toast } = useToast();
  const activeOrganizationId = useOrganizationStore((state) => state.activeOrganizationId);
  const billing = useQuery({ queryKey: ['billing'], queryFn: api.billing, retry: 1 });
  const changePlan = useMutation({
    mutationFn: (planCode: string) => api.updateBilling({ planCode }),
    onSuccess: (result) => {
      toast({ title: 'Plan updated', description: `Subscription status: ${result.subscription.status}. No payment was collected.` });
      logEvent({ severity: 'success', category: 'SYSTEM', title: 'Subscription plan updated', detail: `Plan ${result.subscription.planId}; status ${result.subscription.status}. Administrative state only.`, view: 'billing' });
      void billing.refetch();
    },
    onError: (error) => toast({ title: 'Plan change failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const cancel = useMutation({
    mutationFn: () => api.updateBilling({ action: 'cancel' }),
    onSuccess: () => { toast({ title: 'Subscription cancellation recorded' }); void billing.refetch(); },
    onError: (error) => toast({ title: 'Cancellation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const resume = useMutation({
    mutationFn: () => api.updateBilling({ action: 'resume' }),
    onSuccess: () => { toast({ title: 'Subscription resumed' }); void billing.refetch(); },
    onError: (error) => toast({ title: 'Resume failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const invoices = useQuery({
    queryKey: ['billing-invoices', activeOrganizationId],
    queryFn: () => billingRequest<InvoiceListResponse>('/api/v1/billing/invoices'),
    retry: 1,
  });
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleMethod, setSettleMethod] = useState<'manual_bank' | 'manual_cash'>('manual_bank');
  const [settleReference, setSettleReference] = useState('');
  const issueInvoice = useMutation({
    mutationFn: () => billingRequest<InvoiceIssueResponse>('/api/v1/billing/invoices', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (result) => {
      toast({ title: result.created ? 'Period invoice issued' : 'Invoice already open', description: `${result.invoice.number} · ${formatMoney(result.invoice.amountMinor, result.invoice.currency)}. Settlement remains manual.` });
      void invoices.refetch();
    },
    onError: (error) => toast({ title: 'Invoice issue failed', description: error instanceof Error ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const settle = useMutation({
    mutationFn: (input: { invoiceId: string; amountMinor: number; method: 'manual_bank' | 'manual_cash'; reference?: string }) => billingRequest<InvoiceSettleResponse>(`/api/v1/billing/invoices/${input.invoiceId}/settle`, {
      method: 'POST',
      body: JSON.stringify({ amountMinor: input.amountMinor, method: input.method, ...(input.reference ? { reference: input.reference } : {}) }),
    }),
    onSuccess: (result) => {
      setSettlingId(null);
      setSettleReference('');
      toast({ title: 'Settlement recorded', description: `${result.invoice.number} marked paid. No card processor was involved.` });
      logEvent({ severity: 'success', category: 'SYSTEM', title: 'Invoice settled manually', detail: `${result.invoice.number} paid; linked subscription activated for the next period.`, view: 'billing' });
      void invoices.refetch();
      void billing.refetch();
    },
    onError: (error) => toast({ title: 'Settlement rejected', description: error instanceof Error ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const voidOne = useMutation({
    mutationFn: (invoiceId: string) => billingRequest<{ invoice: InvoiceRow }>(`/api/v1/billing/invoices/${invoiceId}/void`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (result) => {
      setSettlingId(null);
      toast({ title: 'Invoice voided', description: `${result.invoice.number} can no longer be settled.` });
      void invoices.refetch();
    },
    onError: (error) => toast({ title: 'Void failed', description: error instanceof Error ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  if (billing.isError) return <FaultPanel error={billing.error} onRetry={() => billing.refetch()} label="Plans and usage" />;

  const currentCode = billing.data?.subscription.plan?.code ?? billing.data?.plans.find((plan) => plan.id === billing.data?.subscription.planId)?.code;
  const entitlements = billing.data?.entitlements;
  const usage = billing.data?.usage ?? {};

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <SectionHeader
        kicker="Commercial controls · configurable entitlements"
        title="Plans & Usage"
        description={activeOrganizationId ? 'Organization plan, quotas, and successful-operation usage. Pricing and limits are database configuration, not client-side rules.' : 'Personal plan, quotas, and successful-operation usage. Organization trials are managed from the Organization Workspace.'}
        actions={<StatusPill status={billing.data?.subscription.status ?? 'loading'} pulse={false} />}
      />

      <div className="hud p-4">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-signal" /><div><p className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">Provider-neutral billing</p><p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-dim">{billing.data?.paymentNote ?? 'Reading billing configuration…'} Failed and cancelled jobs are never metered as successful operations.</p></div></div>
      </div>

      {entitlements && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(METRIC_LABELS).map(([metric, label]) => {
            const used = usage[metric] ?? 0;
            const limit = entitlements.limits[metric] ?? 0;
            const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
            return <HudPanel key={metric} calm className="p-4"><TelemetryStat label={label} value={`${used.toLocaleString()} / ${limit.toLocaleString()}`} hint={`${pct}% of configured quota`} /><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2"><div className="h-full bg-aqua" style={{ width: `${pct}%` }} /></div></HudPanel>;
          })}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {(billing.data?.plans ?? []).map((plan) => {
          const current = plan.code === currentCode;
          return (
            <HudPanel key={plan.id} calm className={`flex flex-col gap-3 p-4 ${current ? 'border-aqua/50' : ''}`}>
              <div className="flex items-start justify-between gap-2"><div><p className="kicker">{plan.code}</p><h3 className="mt-1 font-display text-lg font-bold text-ink">{plan.name}</h3></div>{current ? <StatusPill status="current plan" pulse={false} className="border-aqua/40 text-aqua" /> : <CreditCard className="h-4 w-4 text-faint" />}</div>
              <p className="text-[11px] leading-relaxed text-dim">{plan.description}</p>
              <p className="font-display text-2xl font-bold text-ink">{formatPrice(plan)}</p>
              <ul className="grid gap-1.5 text-[11px] text-dim">
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-signal" />{plan.entitlements.limits.farms.toLocaleString()} farms</li>
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-signal" />{plan.entitlements.limits.processing_jobs_per_month.toLocaleString()} jobs / month</li>
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-signal" />{plan.entitlements.limits.reports_per_month.toLocaleString()} reports / month</li>
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-signal" />API access: {plan.entitlements.capabilities.api_access ? 'included' : 'not included'}</li>
                <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-signal" />Webhooks: {plan.entitlements.capabilities.webhooks ? 'included' : 'not included'}</li>
              </ul>
              <Button variant={current ? 'outline' : 'default'} disabled={current || changePlan.isPending} onClick={() => changePlan.mutate(plan.code)} className="mt-auto h-9 font-mono text-xs uppercase tracking-wide-mc">{current ? 'Current plan' : 'Select plan'}</Button>
            </HudPanel>
          );
        })}
      </div>

      <HudPanel calm className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Receipt className="h-4 w-4 text-signal" />
          <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Invoices & manual settlement</h3>
          <Button
            variant="outline"
            className="ml-auto h-8 border-edge font-mono text-[10px] uppercase tracking-wide-mc"
            onClick={() => issueInvoice.mutate()}
            disabled={issueInvoice.isPending || !billing.data?.subscription.id}
          >
            Issue period invoice
          </Button>
        </div>
        <p className="max-w-3xl text-[11px] leading-relaxed text-dim">
          Settlement is recorded manually against a bank transfer or cash receipt by an authorized billing manager. No card processor or payment provider is connected, so the platform never charges a card. Recording a settlement marks the invoice paid and activates the linked subscription for the next period.
        </p>
        {invoices.isError ? (
          <FaultPanel error={invoices.error} onRetry={() => invoices.refetch()} label="Invoices" />
        ) : (
          <div className="grid gap-3">
            {(invoices.data?.invoices ?? []).map((invoice) => (
              <div key={invoice.id} className="grid gap-2 border-b border-edge/60 pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[11px] text-ink">{invoice.number}</code>
                  <StatusPill status={invoice.status} pulse={false} />
                  <span className="font-mono text-xs text-ink">{formatMoney(invoice.amountMinor, invoice.currency)}</span>
                  <span className="telemetry text-[10px] text-faint">{formatPeriod(invoice)}</span>
                  <span className="text-[10px] text-faint">due {invoice.dueAt.slice(0, 10)}</span>
                  {invoice.status === 'open' && (
                    <div className="ml-auto flex gap-2">
                      <Button
                        variant="outline"
                        className="h-8 border-edge font-mono text-[10px] uppercase tracking-wide-mc"
                        onClick={() => {
                          setSettlingId(settlingId === invoice.id ? null : invoice.id);
                          setSettleAmount((invoice.amountMinor / 100).toFixed(2));
                          setSettleMethod('manual_bank');
                          setSettleReference('');
                        }}
                      >
                        {settlingId === invoice.id ? 'Close form' : 'Record settlement'}
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-8 font-mono text-[10px] uppercase tracking-wide-mc text-crit"
                        onClick={() => voidOne.mutate(invoice.id)}
                        disabled={voidOne.isPending}
                      >
                        Void
                      </Button>
                    </div>
                  )}
                </div>
                {invoice.payments.length > 0 && (
                  <p className="telemetry text-[10px] text-faint">
                    {invoice.payments.map((payment) => `${payment.method}${payment.reference ? ` · ${payment.reference}` : ''} · ${formatMoney(payment.amountMinor, payment.currency)} · ${payment.status}`).join('  |  ')}
                  </p>
                )}
                {settlingId === invoice.id && (
                  <form
                    className="grid gap-2 rounded-sm border border-edge bg-panel-2/50 p-2 md:grid-cols-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!settlingId) return;
                      const amountMinor = Math.round(Number(settleAmount) * 100);
                      if (!Number.isFinite(amountMinor) || amountMinor < 0) {
                        toast({ title: 'Invalid amount', description: 'Enter the settled amount in the invoice currency.', variant: 'destructive' });
                        return;
                      }
                      settle.mutate({ invoiceId: settlingId, amountMinor, method: settleMethod, reference: settleReference.trim() || undefined });
                    }}
                  >
                    <Label className="grid gap-1 text-[10px] text-dim">
                      Manual method
                      <select
                        value={settleMethod}
                        onChange={(event) => setSettleMethod(event.target.value === 'manual_cash' ? 'manual_cash' : 'manual_bank')}
                        className="h-9 rounded-sm border border-edge bg-panel px-2 text-xs text-ink"
                      >
                        <option value="manual_bank">Bank transfer</option>
                        <option value="manual_cash">Cash</option>
                      </select>
                    </Label>
                    <Label className="grid gap-1 text-[10px] text-dim">
                      Amount ({invoice.currency})
                      <Input value={settleAmount} onChange={(event) => setSettleAmount(event.target.value)} inputMode="decimal" required className="border-edge bg-panel text-ink" />
                    </Label>
                    <Label className="grid gap-1 text-[10px] text-dim">
                      Reference
                      <Input value={settleReference} onChange={(event) => setSettleReference(event.target.value)} maxLength={200} placeholder="Receipt or transfer reference" className="border-edge bg-panel text-ink" />
                    </Label>
                    <div className="flex items-end gap-2">
                      <Button type="submit" disabled={settle.isPending} className="h-9 font-mono text-[10px] uppercase tracking-wide-mc">Record settlement</Button>
                      <Button type="button" variant="ghost" className="h-9 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => setSettlingId(null)}>Cancel</Button>
                    </div>
                  </form>
                )}
              </div>
            ))}
            {!invoices.isLoading && (invoices.data?.invoices.length ?? 0) === 0 && (
              <p className="text-[11px] leading-relaxed text-dim">No invoices yet. Issue the current period invoice to open a manual settlement record. Payment provider integration is intentionally absent until an adapter is reviewed.</p>
            )}
          </div>
        )}
      </HudPanel>

      <OnchainSupportCard />

      {billing.data?.subscription.id && (
        <HudPanel calm className="flex flex-wrap items-center gap-3 p-4">
          <Gauge className="h-4 w-4 text-caution" />
          <p className="text-xs text-dim">Cancellation changes subscription state only; it does not delete organization data.</p>
          {billing.data.subscription.status === 'canceled' ? <Button variant="outline" className="ml-auto h-8 font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => resume.mutate()} disabled={resume.isPending}>Resume subscription</Button> : <Button variant="outline" className="ml-auto h-8 border-crit/40 font-mono text-[10px] uppercase tracking-wide-mc text-crit" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel subscription</Button>}
        </HudPanel>
      )}
      <ApiKeysPanel />
      <WebhooksPanel />
    </div>
  );
}
