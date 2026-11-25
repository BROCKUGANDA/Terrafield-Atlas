'use client';

import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, Building2, Flag, ShieldCheck, Users } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HudPanel, SectionHeader, StatusPill, TelemetryStat } from '@/components/ui-mc/kit';
import { FaultPanel } from '@/components/system/query-state';

export function AdminView() {
  const { toast } = useToast();
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: api.adminOverview, retry: false });
  const [flag, setFlag] = useState({ key: '', description: '', enabled: false });
  const updateFlag = useMutation({
    mutationFn: (body: { key: string; description: string; enabled: boolean }) => api.updateFeatureFlag(body),
    onSuccess: () => { toast({ title: 'Feature flag updated' }); void overview.refetch(); },
    onError: (error) => toast({ title: 'Feature flag update failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  if (overview.isError) return <FaultPanel error={overview.error} onRetry={() => overview.refetch()} label="Platform administration" />;
  const data = overview.data;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <SectionHeader kicker="Platform administration · super-admin only" title="Operations Control" description="Organization and user oversight, queue health, failed jobs, audit history, source status, and feature flags. Every action is enforced by the server administrator guard." actions={<StatusPill status="administrator" pulse={false} className="border-signal/40 text-signal" />} />
      {data && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><TelemetryStat label="Organizations" value={data.organizations.length} hint="latest 100" /><TelemetryStat label="Users" value={data.users.length} hint="verified + pending" /><TelemetryStat label="Queue depth" value={Object.values(data.queue.depth).reduce((sum, value) => sum + value, 0)} hint={`${data.queue.workers.length} worker heartbeat(s)`} /><TelemetryStat label="Failed jobs" value={data.failedJobs.length} hint="latest 50 terminal failures" /></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-aqua" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Organizations</h3></div><div className="max-h-80 overflow-auto">{data?.organizations.map((organization) => <div key={organization.id} className="flex flex-wrap items-center gap-2 border-b border-edge/60 py-2 last:border-0"><div className="min-w-0 flex-1"><p className="truncate text-xs text-ink">{organization.name}</p><p className="telemetry text-[10px] text-faint">{organization.slug} · {organization.country ?? 'Global'}</p></div><span className="telemetry text-[10px] text-dim">{organization.farms} farms · {organization.members} members</span></div>)}</div></HudPanel>
        <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><Users className="h-4 w-4 text-iris" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Users</h3></div><div className="max-h-80 overflow-auto">{data?.users.map((user) => <div key={user.id} className="flex flex-wrap items-center gap-2 border-b border-edge/60 py-2 last:border-0"><div className="min-w-0 flex-1"><p className="truncate text-xs text-ink">{user.name ?? user.email}</p><p className="telemetry text-[10px] text-faint">{user.email}</p></div><StatusPill status={user.isAdmin ? 'admin' : user.emailVerified ? 'verified' : 'pending'} pulse={false} /></div>)}</div></HudPanel>
      </div>

      <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><Flag className="h-4 w-4 text-caution" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Feature flags</h3></div><div className="grid gap-2">{data?.featureFlags.map((item) => <div key={item.key} className="flex flex-wrap items-center gap-3 border-b border-edge/60 py-2 last:border-0"><div className="min-w-0 flex-1"><p className="font-mono text-xs text-ink">{item.key}</p><p className="text-[10px] text-faint">{item.description}</p></div><StatusPill status={item.enabled ? 'enabled' : 'disabled'} pulse={false} /><Button variant="outline" size="sm" className="h-8 font-mono text-[10px]" onClick={() => updateFlag.mutate({ key: item.key, description: item.description, enabled: !item.enabled })}>{item.enabled ? 'Disable' : 'Enable'}</Button></div>)}</div><form className="grid gap-2 border-t border-edge pt-3 md:grid-cols-[1fr_2fr_auto_auto]" onSubmit={(event) => { event.preventDefault(); if (flag.key && flag.description) updateFlag.mutate(flag); }}><Label className="grid gap-1 text-[11px] text-dim">Key<Input value={flag.key} onChange={(event) => setFlag({ ...flag, key: event.target.value })} required placeholder="markets.enabled" className="border-edge bg-panel text-ink" /></Label><Label className="grid gap-1 text-[11px] text-dim">Description<Input value={flag.description} onChange={(event) => setFlag({ ...flag, description: event.target.value })} required className="border-edge bg-panel text-ink" /></Label><label className="flex items-end gap-2 pb-2 text-[11px] text-dim"><input type="checkbox" checked={flag.enabled} onChange={(event) => setFlag({ ...flag, enabled: event.target.checked })} />Enabled</label><Button type="submit" disabled={updateFlag.isPending} className="h-9 font-mono text-xs uppercase tracking-wide-mc">Save flag</Button></form></HudPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-crit" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Failed jobs</h3></div>{data?.failedJobs.map((job) => <div key={job.id} className="border-b border-edge/60 py-2 last:border-0"><p className="telemetry text-[10px] text-dim">{job.type} · {job.status} · {job.id}</p><p className="mt-1 text-[10px] text-crit">{job.error ?? 'No error detail retained.'}</p></div>)}</HudPanel>
        <HudPanel calm className="flex flex-col gap-3"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-signal" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Audit history</h3></div><div className="max-h-80 overflow-auto">{data?.audit.map((event) => <div key={event.id} className="border-b border-edge/60 py-1.5 last:border-0"><p className="telemetry text-[10px] text-dim">{event.action} · {event.actor}</p><p className="telemetry text-[9px] text-faint">{event.createdAt} · target {event.targetId ?? '—'}{event.organizationId ? ` · org ${event.organizationId}` : ''}</p></div>)}</div></HudPanel>
      </div>
    </div>
  );
}
