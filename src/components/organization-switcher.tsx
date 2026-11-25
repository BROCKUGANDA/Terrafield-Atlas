'use client';

import { Building2, UserRound } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useOrganizationStore } from '@/components/state/organization-store';
import { useSession } from '@/components/state/store';
import { logEvent } from '@/components/state/log-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function OrganizationSwitcher() {
  const queryClient = useQueryClient();
  const activeOrganizationId = useOrganizationStore((state) => state.activeOrganizationId);
  const setActiveOrganizationId = useOrganizationStore((state) => state.setActiveOrganizationId);
  const setActiveFarmId = useSession((state) => state.setActiveFarmId);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: api.organizations, staleTime: 60_000, retry: 1 });

  if (organizations.isError || (!organizations.isLoading && !organizations.data?.organizations.length)) return null;

  return (
    <Select
      value={activeOrganizationId ?? 'personal'}
      onValueChange={(value) => {
        const id = value === 'personal' ? null : value;
        setActiveOrganizationId(id);
        setActiveFarmId(null);
        void queryClient.invalidateQueries();
        const name = value === 'personal' ? 'Personal workspace' : organizations.data?.organizations.find((organization) => organization.id === value)?.name ?? value;
        logEvent({
          severity: 'info',
          category: 'SYSTEM',
          title: `Workspace switched — ${name}`,
          detail: 'Server-side organization membership and permissions are re-evaluated for every request.',
          view: useSession.getState().view,
        });
      }}
    >
      <SelectTrigger className="h-8 w-40 border-edge bg-panel text-xs text-dim sm:w-48" aria-label="Active workspace">
        <SelectValue placeholder="Workspace" />
      </SelectTrigger>
      <SelectContent className="border-edge bg-popover text-dim">
        <SelectItem value="personal" className="text-xs">
          <span className="flex items-center gap-2"><UserRound className="h-3.5 w-3.5 text-faint" /> Personal workspace</span>
        </SelectItem>
        {(organizations.data?.organizations ?? []).map((organization) => (
          <SelectItem key={organization.id} value={organization.id} className="text-xs">
            <span className="flex items-center gap-2"><Building2 className="h-3.5 w-3.5 text-aqua" /> {organization.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
