'use client';

import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Map, LineChart, Tractor, Sprout, ScrollText, Flame, FileText,
  Settings, Home, Command, RefreshCw, ClipboardCopy, LogOut, Keyboard,
  Download, MapPin, Search, CircleSlash, Compass,
} from 'lucide-react';
import { useSession, type ViewKey } from '@/components/state/store';
import { useUiStore } from '@/components/state/ui-store';
import { useTourStore } from '@/components/state/tour-store';
import { logEvent } from '@/components/state/log-store';
import { api, ApiRequestError } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup,
  CommandItem, CommandSeparator, CommandShortcut,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const NAV_ITEMS: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; shortcut: string; blurb: string }[] = [
  { key: 'landing', label: 'Mission Overview', icon: Home, shortcut: 'O', blurb: 'Mission brief & demo access' },
  { key: 'dashboard', label: 'Earth Intelligence', icon: LayoutDashboard, shortcut: 'D', blurb: 'POWER coverage & ingestion' },
  { key: 'explorer', label: 'Geospatial Explorer', icon: Map, shortcut: 'E', blurb: 'GIBS imagery & fire layers' },
  { key: 'analysis', label: 'Environmental Analysis', icon: LineChart, shortcut: 'A', blurb: 'Mann-Kendall trend statistics' },
  { key: 'fire', label: 'Fire Intelligence', icon: Flame, shortcut: 'F', blurb: 'VIIRS active-fire detections' },
  { key: 'farm', label: 'Farm Workspace', icon: Tractor, shortcut: 'W', blurb: 'Boundaries, soil tests, notes' },
  { key: 'rotation', label: 'Rotation Planner', icon: Sprout, shortcut: 'R', blurb: 'Compare scenario scores' },
  { key: 'reports', label: 'Field Reports', icon: FileText, shortcut: 'B', blurb: 'Assembled evidence documents' },
  { key: 'provenance', label: 'Evidence & Provenance', icon: ScrollText, shortcut: 'P', blurb: 'Request ledger & licenses' },
  { key: 'settings', label: 'System Health', icon: Settings, shortcut: 'S', blurb: 'Engines, cache, breakers' },
];

/** Header trigger chip: ⌘K opens the palette from anywhere. */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const [isApple, setIsApple] = React.useState(false);
  React.useEffect(() => {
    setIsApple(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);
  return (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      aria-label="Open command palette (Ctrl K)"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-sm border border-edge bg-panel px-2 text-dim transition-colors hover:border-nasa/50 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2',
        className,
      )}
      style={{ outlineColor: 'var(--nasa)' }}
      title="Command palette — jump to any module, region, farm or operation"
    >
      <Search className="h-3.5 w-3.5 text-faint" aria-hidden />
      <span className="font-mono text-[10px] uppercase tracking-wide-mc">cmd</span>
      <kbd className="telemetry rounded-sm border border-edge bg-panel-2 px-1.5 py-0.5 text-[9px] text-dim" aria-hidden>
        {isApple ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
}

/** The ⌘K console command palette + keyboard-shortcuts overlay. */
export function CommandPalette() {
  const { view, setView, location, setLocation, activeFarmId, setActiveFarmId, operator, logout } = useSession();
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const setLogOpen = useUiStore((s) => s.setLogOpen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const { start: startTour, status: tourStatus } = useTourStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const regions = useQuery({ queryKey: ['regions'], queryFn: api.regions, staleTime: 300_000, retry: 1 });
  const farms = useQuery({ queryKey: ['farms'], queryFn: api.farms, staleTime: 120_000, retry: 1 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000, retry: 1 });

  const close = () => setPaletteOpen(false);

  const ingest = useMutation({
    mutationFn: () =>
      api.ingest(activeFarmId ? { farmId: activeFarmId, years: 12 } : { lat: location.lat, lon: location.lon, years: 12 }),
    onSuccess: (res) => {
      const idempotent = res.outcome.rowsWritten === 0 && res.outcome.validPoints > 0;
      logEvent({
        severity: 'success',
        category: 'INGEST',
        title: idempotent ? 'POWER record already current' : 'NASA POWER record ingested',
        detail: idempotent
          ? `Idempotent re-ingest: ${res.outcome.validPoints.toLocaleString()} real points re-verified from POWER (${res.outcome.start} → ${res.outcome.end}); 0 new rows because every variable+date is already stored.`
          : `${res.outcome.rowsWritten.toLocaleString()} real observations (${res.outcome.start} → ${res.outcome.end}); ${res.outcome.missingPoints} missing days reported as missing.`,
        view,
      });
      toast({
        title: idempotent ? 'POWER record already current' : 'NASA POWER record ingested',
        description: idempotent
          ? `0 new rows — all ${res.outcome.validPoints.toLocaleString()} real points already stored; re-verified against POWER.`
          : `${res.outcome.rowsWritten.toLocaleString()} real observations stored; ${res.outcome.missingPoints} missing days reported.`,
      });
      queryClient.invalidateQueries({ queryKey: ['system-status'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
    },
    onError: (err) => {
      logEvent({
        severity: 'crit',
        category: 'INGEST',
        title: 'POWER ingestion failed',
        detail: err instanceof ApiRequestError ? `${err.code} — ${err.message}` : 'Unexpected error; no data fabricated.',
        correlationId: err instanceof ApiRequestError ? err.correlationId : undefined,
        view,
      });
      toast({
        title: 'POWER ingestion failed',
        description: err instanceof ApiRequestError ? err.message : 'Unexpected error. No data fabricated.',
        variant: 'destructive',
      });
    },
  });

  const refreshAll = async () => {
    logEvent({
      severity: 'info',
      category: 'SYSTEM',
      title: 'Console telemetry refreshed',
      detail: 'All cached console queries invalidated; data will re-request from source with fresh retrieval times.',
      view,
    });
    await queryClient.invalidateQueries();
    toast({ title: 'Console telemetry refresh', description: 'Cached queries invalidated — views will re-request from source.' });
  };

  const copyDiagnostics = async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      console: 'TerraField Atlas — NASA Space Apps 2026 (demo build)',
      operator: operator ? { callsign: operator.callsign, role: operator.role } : null,
      activeView: view,
      geography: { lat: location.lat, lon: location.lon, label: location.label },
      activeFarmId,
      link: health.data ? { status: health.data.status } : { status: 'unknown' },
      browser: { online: typeof navigator !== 'undefined' ? navigator.onLine : null },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      logEvent({ severity: 'info', category: 'SYSTEM', title: 'Operator diagnostics copied', detail: 'Console state snapshot placed on the clipboard.', view });
      toast({ title: 'Diagnostics copied', description: 'Console state snapshot copied to the clipboard as JSON.' });
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard unavailable in this browser.', variant: 'destructive' });
    }
  };

  const signOut = () => {
    // store.logout() itself writes the AUTH event to the mission log.
    logout();
    toast({ title: 'Signed out', description: 'Operator session closed. Persisted console state kept for the next sign-in.' });
  };

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      title="TerraField command palette"
      description="Jump to a console module, switch geography or farm, or run an operation."
      className="border border-edge bg-popover text-dim shadow-[0_24px_80px_rgba(0,0,0,0.55)] sm:max-w-[580px]"
    >
      <CommandInput
        placeholder="Type a module, region, farm or operation…"
        className="telemetry text-[13px] text-ink placeholder:text-faint"
      />
      <CommandList className="max-h-[380px]">
        <CommandEmpty className="py-6 text-center text-xs text-faint">
          No match — try a module name, a region, or an operation like “ingest”.
        </CommandEmpty>

        <CommandGroup heading="Navigate" className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-mission [&_[cmdk-group-heading]]:text-nasa">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.key}
                value={`${item.label} ${item.key} ${item.blurb}`}
                onSelect={() => {
                  setView(item.key);
                  logEvent({ severity: 'info', category: 'SYSTEM', title: `Module opened — ${item.label}`, detail: 'Via command palette.', view: item.key });
                  close();
                }}
                className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
              >
                <Icon className={cn('h-4 w-4', view === item.key ? 'text-nasa' : 'text-faint')} aria-hidden />
                <span className="truncate">{item.label}</span>
                <span className="ml-2 hidden truncate text-[11px] text-faint xl:inline">{item.blurb}</span>
                <CommandShortcut className="telemetry text-[10px] text-faint">{item.shortcut}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator className="bg-edge" />

        <CommandGroup heading="Geography — curated demo presets" className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-mission [&_[cmdk-group-heading]]:text-nasa">
          {(regions.data?.regions ?? []).map((r) => {
            const active = Math.abs(location.lat - r.lat) < 0.01 && Math.abs(location.lon - r.lon) < 0.01;
            return (
              <CommandItem
                key={r.key}
                value={`${r.name} ${r.country} ${r.key}`}
                onSelect={() => {
                  setLocation({ lat: r.lat, lon: r.lon, label: r.name, country: r.country, context: r.croppingContext });
                  logEvent({ severity: 'info', category: 'SYSTEM', title: `Geography set — ${r.name}`, detail: `${r.country} · ${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}°. Views now target this location.`, view });
                  close();
                }}
                className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
              >
                <MapPin className={cn('h-4 w-4', active ? 'text-aqua' : 'text-faint')} aria-hidden />
                <span className="truncate">{r.name}</span>
                <CommandShortcut className="telemetry text-[10px] text-faint">{r.country}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator className="bg-edge" />

        <CommandGroup heading="Farms" className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-mission [&_[cmdk-group-heading]]:text-nasa">
          <CommandItem
            value="detach farm none clear active"
            onSelect={() => {
              setActiveFarmId(null);
              logEvent({ severity: 'info', category: 'FARM', title: 'Active farm detached', detail: 'Console now targets the free geography instead of a registered farm.', view });
              close();
            }}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <CircleSlash className="h-4 w-4 text-faint" aria-hidden />
            <span>No active farm (free geography)</span>
            {!activeFarmId && <span className="ml-auto font-mono text-[9px] uppercase tracking-wide-mc text-signal">active</span>}
          </CommandItem>
          {(farms.data?.farms ?? []).map((f) => {
            const active = activeFarmId === f.id;
            return (
              <CommandItem
                key={f.id}
                value={`${f.name} ${f.country ?? ''} ${f.region ?? ''} farm`}
                onSelect={() => {
                  setActiveFarmId(f.id);
                  logEvent({ severity: 'info', category: 'FARM', title: `Active farm set — ${f.name}`, detail: `Farm operations now target this registered boundary (${f.areaHa ? `${f.areaHa.toFixed(1)} ha` : 'area unknown'}).`, view });
                  close();
                }}
                className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
              >
                <Tractor className={cn('h-4 w-4', active ? 'text-signal' : 'text-faint')} aria-hidden />
                <span className="truncate">{f.name}</span>
                {active && <span className="ml-auto font-mono text-[9px] uppercase tracking-wide-mc text-signal">active</span>}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator className="bg-edge" />

        <CommandGroup heading="Operations" className="[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-mission [&_[cmdk-group-heading]]:text-nasa">
          <CommandItem
            value="guided tour first run walkthrough restart tour console tutorial onboarding help intro"
            onSelect={() => {
              startTour();
              logEvent({
                severity: 'info',
                category: 'SYSTEM',
                title: 'Guided tour started (command palette)',
                detail: 'Operator launched the first-run walkthrough from the ⌘K palette.',
                view,
              });
              toast({ title: 'Guided tour started', description: 'Navigate with the Next buttons or ←/→ keys; Esc leaves the tour.' });
              close();
            }}
            disabled={tourStatus === 'active'}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <Compass className="h-4 w-4 text-nasa" aria-hidden />
            <span>{tourStatus === 'active' ? 'Guided tour is already running' : 'Start guided tour — console walkthrough'}</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">17 steps</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="ingest nasa power 12 years ingest power nasa observations fetch retrieve weather meteorology"
            onSelect={() => {
              logEvent({ severity: 'info', category: 'INGEST', title: 'POWER ingestion requested', detail: `12-year meteorology request for ${activeFarmId ? 'the active farm' : location.label}. Real rows only; missing days reported as missing.`, view });
              ingest.mutate();
              close();
            }}
            disabled={ingest.isPending}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <Download className={cn('h-4 w-4', ingest.isPending ? 'text-caution' : 'text-aqua')} aria-hidden />
            <span>{ingest.isPending ? 'Ingesting NASA POWER…' : 'Ingest NASA POWER — 12 years'}</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">real data</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="refresh console telemetry refresh reload invalidate cache telemetry caches"
            onSelect={() => {
              void refreshAll();
              close();
            }}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <RefreshCw className="h-4 w-4 text-aqua" aria-hidden />
            <span>Refresh console telemetry</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">re-request</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="copy operator diagnostics copy diagnostics state snapshot clipboard support"
            onSelect={() => {
              void copyDiagnostics();
              close();
            }}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <ClipboardCopy className="h-4 w-4 text-iris" aria-hidden />
            <span>Copy operator diagnostics</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">json</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="open mission log mission log events ledger audit history"
            onSelect={() => {
              close();
              setLogOpen(true);
            }}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <ScrollText className="h-4 w-4 text-iris" aria-hidden />
            <span>Open mission log</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">audit</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="keyboard shortcuts keyboard shortcuts keys help hotkeys"
            onSelect={() => {
              close();
              setHelpOpen(true);
            }}
            className="text-[13px] data-[selected=true]:bg-nasa/10 data-[selected=true]:text-ink"
          >
            <Keyboard className="h-4 w-4 text-caution" aria-hidden />
            <span>Keyboard shortcuts</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">?</CommandShortcut>
          </CommandItem>

          <CommandItem
            value="sign out operator sign out logout exit operator session"
            onSelect={() => {
              signOut();
              close();
            }}
            className="text-[13px] data-[selected=true]:bg-crit/10 data-[selected=true]:text-ink"
          >
            <LogOut className="h-4 w-4 text-crit" aria-hidden />
            <span>Sign out operator</span>
            <CommandShortcut className="telemetry text-[10px] text-faint">exit</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between border-t border-edge px-3 py-2">
        <p className="font-mono text-[9px] uppercase tracking-wide text-faint">
          <Command className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
          TerraField console · every action logged to the mission log
        </p>
        <p className="telemetry hidden text-[9px] text-faint sm:block">↑↓ select · ↵ run · esc close</p>
      </div>
    </CommandDialog>
  );
}

/** Keyboard-shortcuts overlay (? or via palette). */
export function ShortcutsHelp() {
  const helpOpen = useUiStore((s) => s.helpOpen);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);

  const rows: { keys: string; label: string }[] = [
    { keys: '⌘ K / Ctrl K', label: 'Open the command palette' },
    { keys: '?', label: 'Show this shortcuts overlay' },
    { keys: 'T', label: 'Start / restart the guided tour' },
    { keys: 'O', label: 'Mission Overview' },
    { keys: 'D', label: 'Earth Intelligence' },
    { keys: 'E', label: 'Geospatial Explorer' },
    { keys: 'A', label: 'Environmental Analysis' },
    { keys: 'F', label: 'Fire Intelligence' },
    { keys: 'W', label: 'Farm Workspace' },
    { keys: 'R', label: 'Rotation Planner' },
    { keys: 'B', label: 'Field Reports' },
    { keys: 'P', label: 'Evidence & Provenance' },
    { keys: 'S', label: 'System Health' },
    { keys: 'esc', label: 'Close any overlay' },
  ];

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="border border-edge bg-popover p-0 sm:max-w-[460px]" aria-describedby="shortcuts-desc">
        <DialogHeader className="border-b border-edge px-5 py-4">
          <DialogTitle className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">
            Console hotkeys
          </DialogTitle>
          <DialogDescription id="shortcuts-desc" className="font-mono text-[10px] tracking-wide text-faint">
            Single-key jumps are disabled while typing in any field.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-1 px-5 py-4 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.keys} className="flex items-center justify-between gap-3 rounded-sm px-1.5 py-1.5">
              <span className="truncate text-[12px] text-dim">{r.label}</span>
              <kbd className="telemetry shrink-0 rounded-sm border border-edge bg-panel-2 px-1.5 py-0.5 text-[10px] text-ink">
                {r.keys}
              </kbd>
            </div>
          ))}
        </div>
        <div className="border-t border-edge px-5 py-3">
          <p className="text-[11px] leading-relaxed text-faint">
            The console respects <span className="text-dim">prefers-reduced-motion</span>: all telemetry animations are
            stripped when the OS requests it.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
