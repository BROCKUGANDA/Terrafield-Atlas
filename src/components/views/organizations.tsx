'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Building2, CreditCard, MapPinned, Plus, ShieldCheck, Users } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useOrganizationStore } from '@/components/state/organization-store';
import { useSession } from '@/components/state/store';
import { logEvent } from '@/components/state/log-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HudPanel, SectionHeader, StatusPill, TelemetryStat } from '@/components/ui-mc/kit';
import { EmptyState, FaultPanel } from '@/components/system/query-state';
import { useToast } from '@/hooks/use-toast';

const ROLES = ['admin', 'analyst', 'agronomist', 'researcher', 'field_officer', 'viewer', 'api_service'] as const;

export function OrganizationsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { setView } = useSession();
  const activeOrganizationId = useOrganizationStore((state) => state.activeOrganizationId);
  const setActiveOrganizationId = useOrganizationStore((state) => state.setActiveOrganizationId);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', country: 'Uganda', timezone: 'Africa/Kampala' });
  const [invite, setInvite] = useState({ email: '', role: 'analyst' });
  const [workspaceName, setWorkspaceName] = useState('');

  const organizations = useQuery({ queryKey: ['organizations'], queryFn: api.organizations, retry: 1 });
  const organization = useQuery({
    queryKey: ['organization', activeOrganizationId],
    queryFn: () => api.organization(activeOrganizationId!),
    enabled: Boolean(activeOrganizationId),
    retry: 1,
  });
  const members = useQuery({
    queryKey: ['organization-members', activeOrganizationId],
    queryFn: () => api.members(activeOrganizationId!),
    enabled: Boolean(activeOrganizationId),
    retry: 1,
  });
  const billing = useQuery({ queryKey: ['billing'], queryFn: api.billing, retry: 1 });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['organizations'] });
    void queryClient.invalidateQueries({ queryKey: ['organization'] });
    void queryClient.invalidateQueries({ queryKey: ['organization-members'] });
    void queryClient.invalidateQueries({ queryKey: ['billing'] });
  };

  const create = useMutation({
    mutationFn: () => api.createOrganization(form),
    onSuccess: (result) => {
      setActiveOrganizationId(result.organization.id);
      setCreating(false);
      setForm({ name: '', country: 'Uganda', timezone: 'Africa/Kampala' });
      toast({ title: 'Organization created', description: `${result.organization.name} has a 14-day Cooperative trial and a primary portfolio workspace.` });
      logEvent({ severity: 'success', category: 'SYSTEM', title: `Organization created — ${result.organization.name}`, detail: 'Owner membership, primary workspace, and Cooperative trial created atomically.', view: 'organizations' });
      invalidate();
    },
    onError: (error) => toast({ title: 'Organization creation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const inviteMember = useMutation({
    mutationFn: () => api.inviteMember(activeOrganizationId!, invite),
    onSuccess: (result) => {
      setInvite({ email: '', role: 'analyst' });
      toast({ title: 'Invitation sent', description: `${result.invitation.email} was invited as ${result.invitation.role}.` });
      logEvent({ severity: 'success', category: 'SYSTEM', title: 'Organization invitation sent', detail: `${result.invitation.email} as ${result.invitation.role}.`, view: 'organizations' });
    },
    onError: (error) => toast({ title: 'Invitation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const createWorkspace = useMutation({
    mutationFn: () => api.createWorkspace(activeOrganizationId!, { name: workspaceName }),
    onSuccess: (result) => {
      setWorkspaceName('');
      toast({ title: 'Workspace created', description: result.workspace.name });
      invalidate();
    },
    onError: (error) => toast({ title: 'Workspace creation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const updateMember = useMutation({
    mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) => api.updateMember(activeOrganizationId!, membershipId, { role }),
    onSuccess: () => { void members.refetch(); toast({ title: 'Member role updated' }); },
    onError: (error) => toast({ title: 'Member update failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const rows = organizations.data?.organizations ?? [];
  const current = organization.data?.organization;
  const canManage = current ? ['owner', 'admin'].includes(organizations.data?.organizations.find((row) => row.id === current.id)?.role ?? '') : false;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <SectionHeader
        kicker="Institution workspace · secure team boundary"
        title="Organization Workspace"
        description="Create a cooperative or institutional portfolio, invite verified teammates, group farms into workspaces, and keep every analytical request inside a server-verified organization scope."
        actions={<Button onClick={() => setCreating((value) => !value)} className="h-9 font-mono text-xs uppercase tracking-wide-mc"><Plus className="h-3.5 w-3.5" /> New organization</Button>}
      />

      {creating && (
        <HudPanel className="grid gap-3 p-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Label className="grid gap-1 text-xs text-dim">Organization name<Input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} className="border-edge bg-panel text-ink" placeholder="e.g. Uganda Farmers Cooperative" /></Label>
            <Label className="grid gap-1 text-xs text-dim">Country<Input value={form.country} maxLength={80} onChange={(event) => setForm({ ...form, country: event.target.value })} className="border-edge bg-panel text-ink" /></Label>
            <Label className="grid gap-1 text-xs text-dim">Timezone<Input value={form.timezone} maxLength={80} onChange={(event) => setForm({ ...form, timezone: event.target.value })} className="border-edge bg-panel text-ink" /></Label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => create.mutate()} disabled={create.isPending || form.name.trim().length < 2} className="h-9 font-mono text-xs uppercase tracking-wide-mc">{create.isPending ? 'Creating…' : 'Create with 14-day Cooperative trial'}</Button>
            <span className="text-[11px] text-faint">No payment provider is connected. Trial state is recorded, not billed.</span>
          </div>
        </HudPanel>
      )}

      {organizations.isError ? <FaultPanel error={organizations.error} onRetry={() => organizations.refetch()} label="Organizations" /> : rows.length === 0 && !creating ? (
        <EmptyState
          label="No organization workspace"
          hint="Verified accounts can create a cooperative or institution with a 14-day Cooperative trial. Personal farms and analyses continue to work independently."
          action={<div className="mt-3 flex flex-wrap justify-center gap-2"><Button onClick={() => setCreating(true)} className="h-9 font-mono text-xs uppercase tracking-wide-mc">Create organization</Button><Link href="/account" className="inline-flex h-9 items-center border border-edge px-3 text-xs text-dim hover:text-ink">Account sign-in</Link></div>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <button key={row.id} type="button" onClick={() => setActiveOrganizationId(row.id)} className={`hud hud-calm p-4 text-left transition-colors hover:border-aqua/40 ${activeOrganizationId === row.id ? 'border-aqua/50' : ''}`}>
              <div className="flex items-center justify-between gap-2"><Building2 className="h-5 w-5 text-aqua" /><StatusPill status={row.role} pulse={false} /></div>
              <p className="mt-3 font-display text-sm font-bold uppercase tracking-wide-mc text-ink">{row.name}</p>
              <p className="telemetry mt-1 text-[10px] text-faint">{row.country ?? 'Global'} · {row.timezone}</p>
              <p className="telemetry mt-3 text-[11px] text-dim">{row.farms} farms · {row.members} members · {row.workspaces} workspaces</p>
            </button>
          ))}
        </div>
      )}

      {activeOrganizationId && (
        <>
          {organization.isError ? <FaultPanel error={organization.error} onRetry={() => organization.refetch()} label="Organization" /> : current && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TelemetryStat label="Managed farms" value={current._count.farms} hint="organization portfolio" />
                <TelemetryStat label="Team members" value={current._count.memberships} hint="active + suspended memberships" />
                <TelemetryStat label="Workspaces" value={current.workspaces.length} hint="portfolio groupings" />
                <TelemetryStat label="Saved reports" value={current._count.reports} hint="persisted report records" />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <HudPanel calm className="flex flex-col gap-3">
                  <div className="flex items-center gap-2"><MapPinned className="h-4 w-4 text-signal" /><h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">Portfolio workspaces</h3></div>
                  {current.workspaces.map((workspace) => <div key={workspace.id} className="flex items-center justify-between border-b border-edge/60 py-2 last:border-0"><div><p className="text-sm text-ink">{workspace.name}</p><p className="text-[11px] text-faint">{workspace.description ?? 'No description'}</p></div><span className="telemetry text-xs text-dim">{workspace._count?.farms ?? 0} farms</span></div>)}
                  {canManage && <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (workspaceName.trim()) createWorkspace.mutate(); }}><Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={120} placeholder="New workspace name" className="border-edge bg-panel text-ink" /><Button type="submit" disabled={createWorkspace.isPending || !workspaceName.trim()} className="h-9 font-mono text-xs uppercase tracking-wide-mc">Add</Button></form>}
                </HudPanel>

                <HudPanel calm className="flex flex-col gap-3">
                  <div className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-caution" /><h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">Plan & trial</h3></div>
                  {billing.data ? <>
                    <p className="font-display text-lg font-bold text-ink">{billing.data.subscription.plan?.name ?? 'Explorer'}</p>
                    <StatusPill status={billing.data.subscription.status} pulse={false} />
                    <p className="text-[11px] leading-relaxed text-dim">Farm quota: {billing.data.usage.farms ?? 0} / {billing.data.entitlements.limits.farms}. Processing quota resets monthly.</p>
                    <Button variant="outline" className="mt-2 h-8 w-fit border-edge font-mono text-[10px] uppercase tracking-wide-mc" onClick={() => setView('billing')}>Open plans & usage</Button>
                  </> : <p className="text-xs text-faint">Reading plan state…</p>}
                </HudPanel>
              </div>

              <HudPanel calm className="flex flex-col gap-3">
                <div className="flex items-center gap-2"><Users className="h-4 w-4 text-iris" /><h3 className="font-display text-sm font-semibold uppercase tracking-wide-mc text-ink">Members & invitations</h3><ShieldCheck className="ml-auto h-4 w-4 text-signal" /></div>
                {members.isError ? <FaultPanel error={members.error} onRetry={() => members.refetch()} label="Members" /> : (
                  <div className="overflow-x-auto">
                    <table className="mc-table w-full"><thead><tr><th>Member</th><th>Role</th><th>Status</th></tr></thead><tbody>
                      {(members.data?.members ?? []).map((member) => <tr key={member.id} className="border-b border-edge/60 last:border-0"><td className="px-2 py-2"><span className="text-ink">{member.user.name ?? member.user.email}</span><span className="telemetry ml-2 text-[10px] text-faint">{member.user.email}</span></td><td>{canManage && member.role !== 'owner' ? <Select value={member.role} onValueChange={(role) => updateMember.mutate({ membershipId: member.id, role })}><SelectTrigger className="h-8 w-36 border-edge bg-panel text-xs"><SelectValue /></SelectTrigger><SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}</SelectContent></Select> : <StatusPill status={member.role} pulse={false} />}</td><td><StatusPill status={member.status} pulse={false} /></td></tr>)}
                    </tbody></table>
                  </div>
                )}
                {canManage && <form className="grid gap-2 border-t border-edge pt-3 md:grid-cols-[1fr_180px_auto]" onSubmit={(event) => { event.preventDefault(); if (invite.email) inviteMember.mutate(); }}><Input type="email" required value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} placeholder="teammate@example.org" className="border-edge bg-panel text-ink" /><Select value={invite.role} onValueChange={(role) => setInvite({ ...invite, role })}><SelectTrigger className="border-edge bg-panel text-xs"><SelectValue /></SelectTrigger><SelectContent>{ROLES.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}</SelectContent></Select><Button type="submit" disabled={inviteMember.isPending} className="h-9 font-mono text-xs uppercase tracking-wide-mc">Send invitation</Button></form>}
              </HudPanel>
            </>
          )}
        </>
      )}
    </div>
  );
}
