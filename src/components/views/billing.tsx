'use client';

import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CreditCard, Gauge, ShieldCheck } from 'lucide-react';
import { api, ApiRequestError, type BillingPlan } from '@/lib/api-client';
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
