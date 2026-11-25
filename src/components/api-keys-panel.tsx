'use client';

import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HudPanel, StatusPill } from '@/components/ui-mc/kit';
import { FaultPanel } from '@/components/system/query-state';

const SCOPES = ['farms.read', 'observations.read', 'analyses.read', 'reports.read', 'sources.read'] as const;

export function ApiKeysPanel() {
  const { toast } = useToast();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys, retry: 1 });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['farms.read', 'observations.read', 'sources.read']);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createApiKey({ name, scopes }),
    onSuccess: (result) => {
      setSecret(result.secret);
      setName('');
      toast({ title: 'API key created', description: 'Copy the secret now. It will not be shown again.' });
      void keys.refetch();
    },
    onError: (error) => toast({ title: 'API key creation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => { toast({ title: 'API key revoked' }); void keys.refetch(); },
    onError: (error) => toast({ title: 'Revocation failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  return (
    <HudPanel calm className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-aqua" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Developer API keys</h3><a href="/api/v1/openapi.json" className="ml-auto font-mono text-[10px] uppercase tracking-wide-mc text-aqua underline">OpenAPI 3.1</a></div>
      <p className="text-[11px] leading-relaxed text-dim">Keys are tenant-scoped, hashed at rest, and shown once. Requests require the matching read scope and are checked against plan quotas.</p>
      {secret && <div className="flex flex-wrap items-center gap-2 border border-caution/40 bg-caution/5 p-3"><code className="break-all font-mono text-xs text-ink">{secret}</code><Button variant="outline" size="sm" className="h-8 border-edge font-mono text-[10px]" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast({ title: 'API key copied' })).catch(() => toast({ title: 'Copy failed', variant: 'destructive' }))}><Copy className="h-3.5 w-3.5" />Copy once</Button><Button variant="ghost" size="sm" className="h-8 font-mono text-[10px]" onClick={() => setSecret(null)}>Dismiss</Button></div>}
      {keys.isError ? <FaultPanel error={keys.error} onRetry={() => keys.refetch()} label="API keys" /> : <div className="grid gap-2">{(keys.data?.keys ?? []).map((key) => <div key={key.id} className="flex flex-wrap items-center gap-2 border-b border-edge/60 py-2 last:border-0"><KeyRound className="h-3.5 w-3.5 text-faint" /><div className="min-w-0 flex-1"><p className="text-xs text-ink">{key.name} <span className="telemetry ml-2 text-faint">{key.prefix}…</span></p><p className="telemetry text-[10px] text-faint">{key.scopes.join(' · ')}{key.lastUsedAt ? ` · last used ${key.lastUsedAt.slice(0, 10)}` : ''}</p></div><StatusPill status={key.revokedAt ? 'revoked' : key.expiresAt && key.expiresAt < new Date().toISOString() ? 'expired' : 'active'} pulse={false} />{!key.revokedAt && <Button variant="ghost" size="icon" className="h-8 w-8 text-crit" aria-label={`Revoke ${key.name}`} onClick={() => revoke.mutate(key.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}</div>)}</div>}
      <form className="grid gap-2 border-t border-edge pt-3 md:grid-cols-[180px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); if (name.trim() && scopes.length) create.mutate(); }}>
        <Label className="grid gap-1 text-[11px] text-dim">Key name<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder="Production integration" className="border-edge bg-panel text-ink" /></Label>
        <div className="grid content-start gap-1"><span className="text-[11px] text-dim">Scopes</span><div className="flex flex-wrap gap-2">{SCOPES.map((scope) => <label key={scope} className="flex items-center gap-1 text-[10px] text-dim"><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))} />{scope}</label>)}</div></div>
        <Button type="submit" disabled={create.isPending || !name.trim() || scopes.length === 0} className="h-9 font-mono text-xs uppercase tracking-wide-mc"><Plus className="h-3.5 w-3.5" />Create key</Button>
      </form>
      <p className="flex items-center gap-1.5 text-[10px] text-faint"><ShieldCheck className="h-3.5 w-3.5 text-signal" />Secrets are never written to logs or returned by list endpoints.</p>
    </HudPanel>
  );
}
