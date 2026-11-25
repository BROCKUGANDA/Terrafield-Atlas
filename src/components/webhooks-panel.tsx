'use client';

import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, RadioTower, Trash2, Webhook } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useOrganizationStore } from '@/components/state/organization-store';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HudPanel, StatusPill } from '@/components/ui-mc/kit';
import { FaultPanel } from '@/components/system/query-state';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

const EVENTS = WEBHOOK_EVENTS;

export function WebhooksPanel() {
  const { toast } = useToast();
  const organizationId = useOrganizationStore((state) => state.activeOrganizationId);
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: api.webhooks, enabled: Boolean(organizationId), retry: 1 });
  const [form, setForm] = useState({ name: '', url: '', events: ['job.succeeded', 'farm.created'] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<string | null>(null);
  const deliveries = useQuery({ queryKey: ['webhook-deliveries', deliveriesFor], queryFn: () => api.webhookDeliveries(deliveriesFor!), enabled: Boolean(deliveriesFor), retry: 1 });
  const create = useMutation({
    mutationFn: () => api.createWebhook(form),
    onSuccess: (result) => { setSecret(result.secret); setForm({ name: '', url: '', events: ['job.succeeded', 'farm.created'] }); toast({ title: 'Webhook created', description: 'Copy the signing secret now. It is shown once.' }); void webhooks.refetch(); },
    onError: (error) => toast({ title: 'Webhook creation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.disableWebhook(id),
    onSuccess: () => { toast({ title: 'Webhook disabled' }); void webhooks.refetch(); },
    onError: (error) => toast({ title: 'Disable failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  if (!organizationId) return <HudPanel calm className="p-4 text-xs text-dim">Select an organization workspace to manage signed webhooks.</HudPanel>;

  return (
    <HudPanel calm className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2"><Webhook className="h-4 w-4 text-iris" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Integration webhooks</h3><RadioTower className="ml-auto h-4 w-4 text-signal" /></div>
      <p className="text-[11px] leading-relaxed text-dim">Committed domain events are signed with HMAC-SHA256, delivered from the durable outbox, and retried with bounded backoff. Private, loopback, link-local, and metadata targets are refused.</p>
      {secret && <div className="flex flex-wrap items-center gap-2 border border-caution/40 bg-caution/5 p-3"><code className="break-all font-mono text-xs text-ink">{secret}</code><Button variant="outline" size="sm" className="h-8 border-edge font-mono text-[10px]" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast({ title: 'Signing secret copied' })).catch(() => toast({ title: 'Copy failed', variant: 'destructive' }))}><Copy className="h-3.5 w-3.5" />Copy once</Button><Button variant="ghost" size="sm" className="h-8 font-mono text-[10px]" onClick={() => setSecret(null)}>Dismiss</Button></div>}
      {webhooks.isError ? <FaultPanel error={webhooks.error} onRetry={() => webhooks.refetch()} label="Webhooks" /> : <div className="grid gap-2">{(webhooks.data?.webhooks ?? []).map((webhook) => <div key={webhook.id} className="grid gap-2 border-b border-edge/60 py-2 last:border-0"><div className="flex flex-wrap items-center gap-2"><Webhook className="h-3.5 w-3.5 text-faint" /><div className="min-w-0 flex-1"><p className="text-xs text-ink">{webhook.name}</p><p className="telemetry truncate text-[10px] text-faint">{webhook.url}</p></div><StatusPill status={webhook.status} pulse={false} /><Button variant="ghost" size="sm" className="h-8 font-mono text-[10px]" onClick={() => setDeliveriesFor(deliveriesFor === webhook.id ? null : webhook.id)}>Deliveries</Button>{webhook.status === 'active' && <Button variant="ghost" size="icon" className="h-8 w-8 text-crit" aria-label={`Disable ${webhook.name}`} onClick={() => disable.mutate(webhook.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}</div><p className="telemetry text-[10px] text-faint">{webhook.events.join(' · ')}</p>{deliveriesFor === webhook.id && <div className="rounded-sm border border-edge bg-void/40 p-2">{deliveries.isLoading ? <p className="text-[10px] text-faint">Reading delivery ledger…</p> : deliveries.isError ? <p className="text-[10px] text-crit">Delivery ledger unavailable.</p> : (deliveries.data?.deliveries ?? []).map((delivery) => <div key={delivery.id} className="flex flex-wrap items-center gap-2 border-b border-edge/40 py-1 text-[10px] last:border-0"><StatusPill status={delivery.status} pulse={false} /><span className="telemetry text-dim">{delivery.eventType}</span><span className="telemetry text-faint">{delivery.attempts} attempt(s)</span>{delivery.lastError && <span className="text-crit">{delivery.lastError}</span>}</div>)}</div>}</div>)}</div>}
      <form className="grid gap-2 border-t border-edge pt-3" onSubmit={(event) => { event.preventDefault(); if (form.name.trim() && form.url && form.events.length) create.mutate(); }}>
        <div className="grid gap-2 md:grid-cols-2"><Label className="grid gap-1 text-[11px] text-dim">Name<Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={80} required className="border-edge bg-panel text-ink" /></Label><Label className="grid gap-1 text-[11px] text-dim">HTTPS endpoint<Input type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required placeholder="https://example.org/hooks/terrafield" className="border-edge bg-panel text-ink" /></Label></div>
        <div className="flex flex-wrap gap-2">{EVENTS.map((event) => <label key={event} className="flex items-center gap-1 text-[10px] text-dim"><input type="checkbox" checked={form.events.includes(event)} onChange={(change) => setForm({ ...form, events: change.target.checked ? [...form.events, event] : form.events.filter((item) => item !== event) })} />{event}</label>)}</div>
        <Button type="submit" disabled={create.isPending || !form.name.trim() || !form.url || form.events.length === 0} className="h-9 w-fit font-mono text-xs uppercase tracking-wide-mc">Create signed webhook</Button>
      </form>
    </HudPanel>
  );
}
