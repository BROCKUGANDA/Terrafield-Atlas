'use client';

import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BrainCircuit, CheckCircle2, FileSearch, Play, ShieldCheck } from 'lucide-react';
import { api, ApiRequestError, type AgentRun, type IntelligencePlan } from '@/lib/api-client';
import { useSession } from '@/components/state/store';
import { logEvent } from '@/components/state/log-store';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { HudPanel, SectionHeader, StatusPill } from '@/components/ui-mc/kit';
import { EmptyState, FaultPanel } from '@/components/system/query-state';

const EXAMPLES = [
  'Summarize farms in this cooperative portfolio',
  'Compare rainfall and temperature trends for the selected farm',
  'Summarize recurring fire observations in this workspace',
  'Show soil and crop context for the selected farm',
  'List available datasets and their access conditions',
];

export function IntelligenceView() {
  const { activeFarmId, location } = useSession();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [run, setRun] = useState<AgentRun | null>(null);
  const [plan, setPlan] = useState<IntelligencePlan | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const runs = useQuery({ queryKey: ['intelligence-runs'], queryFn: api.intelligenceRuns, retry: 1 });

  const createPlan = useMutation({
    mutationFn: () => api.intelligencePlans({ query, farmId: activeFarmId ?? undefined, lat: location.lat, lon: location.lon, label: location.label }),
    onSuccess: (response) => {
      setRun(response.run);
      setPlan(response.plan);
      setResult(null);
      logEvent({ severity: 'info', category: 'AI', title: `Analysis plan created — ${response.plan.agent}`, detail: `${response.plan.intent}: ${response.plan.method}`, view: 'intelligence' });
    },
    onError: (error) => toast({ title: 'Planning failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  const approve = useMutation({
    mutationFn: () => api.approveIntelligenceRun(run!.id),
    onSuccess: (response) => {
      setRun(response.run);
      setResult(response.result);
      toast({ title: 'Approved analysis complete', description: 'Every tool execution and evidence reference is recorded.' });
      logEvent({ severity: 'success', category: 'AI', title: 'Approved agent run completed', detail: `Run ${response.run.id} succeeded through permission-controlled tools.`, view: 'intelligence' });
      void runs.refetch();
    },
    onError: (error) => toast({ title: 'Execution failed', description: error instanceof ApiRequestError ? error.message : 'Unexpected error.', variant: 'destructive' }),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <SectionHeader
        kicker="Evidence-first intelligence · typed tool orchestration"
        title="Atlas Intelligence"
        description="Translate a question into an inspectable analytical plan, then approve execution through permission-controlled tools. This is a deterministic planner: it does not invent observations or make autonomous agricultural decisions."
        actions={<StatusPill status={run?.status ?? 'ready to plan'} pulse={false} className="border-iris/40 text-iris" />}
      />

      <HudPanel className="flex flex-col gap-3 p-4">
        <label className="grid gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wide-mc text-faint">Ask an evidence-grounded question</span>
          <Textarea value={query} onChange={(event) => setQuery(event.target.value)} maxLength={1000} rows={3} placeholder="e.g. Compare rainfall anomalies for the selected farm over the last three seasons" className="border-edge bg-panel text-ink" />
        </label>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => <Button key={example} variant="outline" size="sm" className="h-8 border-edge font-mono text-[10px] text-dim" onClick={() => setQuery(example)}>{example}</Button>)}
        </div>
        <Button className="h-9 w-fit font-mono text-xs uppercase tracking-wide-mc" onClick={() => createPlan.mutate()} disabled={createPlan.isPending || query.trim().length < 3}><BrainCircuit className="h-4 w-4" />{createPlan.isPending ? 'Building validated plan…' : 'Inspect analysis plan'}</Button>
      </HudPanel>

      {plan && run && (
        <HudPanel calm className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2"><FileSearch className="h-4 w-4 text-aqua" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Proposed plan · {plan.agent}</h3><StatusPill status={plan.intent} pulse={false} /></div>
          <div className="grid gap-3 md:grid-cols-2">
            <div><p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">Geographic scope</p><p className="mt-1 text-xs text-dim">{plan.geographicScope.label}{plan.geographicScope.farmId ? ` · farm ${plan.geographicScope.farmId}` : ''}</p></div>
            <div><p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">Period</p><p className="telemetry mt-1 text-xs text-dim">{plan.dateRange ? `${plan.dateRange.from} → ${plan.dateRange.to}` : 'Current registry state'}</p></div>
            <div><p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">Datasets</p><p className="mt-1 text-xs text-dim">{plan.datasets.join(' · ') || 'None'}</p></div>
            <div><p className="font-mono text-[9px] uppercase tracking-wide-mc text-faint">Method</p><p className="mt-1 text-xs text-dim">{plan.method}</p></div>
          </div>
          <div className="border-t border-edge pt-3"><p className="font-mono text-[9px] uppercase tracking-wide-mc text-caution">Limitations & assumptions</p><ul className="mt-1 list-inside list-disc space-y-1 text-[11px] text-dim">{plan.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
          <div className="flex flex-wrap items-center gap-3"><Button onClick={() => approve.mutate()} disabled={approve.isPending || plan.intent === 'unsupported' || run.status !== 'awaiting_approval'} className="h-9 font-mono text-xs uppercase tracking-wide-mc"><Play className="h-3.5 w-3.5" />Approve & run</Button><span className="flex items-center gap-1.5 text-[10px] text-faint"><ShieldCheck className="h-3.5 w-3.5 text-signal" />Human approval required · tools are tenant-scoped</span></div>
        </HudPanel>
      )}

      {result !== null && (
        <HudPanel calm className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-signal" /><h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Audited result & evidence</h3></div>
          <pre className="max-h-96 overflow-auto rounded-sm border border-edge bg-void p-3 font-mono text-[11px] leading-relaxed text-dim">{JSON.stringify(result, null, 2)}</pre>
          {run?.evidence && run.evidence.length > 0 && <p className="text-[11px] text-faint">Evidence references: {run.evidence.map((item) => `${item.sourceType}:${item.sourceId}`).join(' · ')}</p>}
        </HudPanel>
      )}

      <HudPanel calm className="flex flex-col gap-3">
        <h3 className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">Recent agent runs</h3>
        {runs.isError ? <FaultPanel error={runs.error} onRetry={() => runs.refetch()} label="Agent runs" /> : runs.data && runs.data.runs.length > 0 ? <div className="grid gap-2">{runs.data.runs.map((item) => <button key={item.id} type="button" className="flex flex-wrap items-center gap-2 border-b border-edge/60 py-2 text-left last:border-0" onClick={async () => { const detail = await api.intelligenceRun(item.id); setRun(detail.run); setPlan(detail.plan); setResult(detail.result); }}><StatusPill status={item.status} pulse={false} /><span className="min-w-0 flex-1 truncate text-xs text-dim">{item.query}</span><span className="telemetry text-[10px] text-faint">{new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')}Z</span></button>)}</div> : <EmptyState label="No agent runs" hint="Approved plans and their evidence will appear here." />}
      </HudPanel>
    </div>
  );
}
