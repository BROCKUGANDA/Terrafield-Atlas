'use client';
import { AccountControls } from '@/components/account-controls';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { LocaleSwitcher, useLocale } from '@/components/locale-switcher';
import { t } from '@/lib/i18n';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Map, LineChart, Tractor, Sprout, ScrollText, Flame,
  FileText, Settings, ChevronRight, Menu, LogOut, Home, FlameKindling,
  Building2, CreditCard, BrainCircuit, Database, ShieldCheck, ShoppingBasket,
} from 'lucide-react';
import { useSession, type ViewKey } from '@/components/state/store';
import { api } from '@/lib/api-client';
import { useConsoleHotkeys } from '@/hooks/use-console-hotkeys';
import { useDigestStream } from '@/hooks/use-digest-stream';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MissionPatch } from '@/components/ui-mc/logo';
import { DegradedBanner } from '@/components/system/degraded-banner';
import { ErrorBoundary } from '@/components/system/error-boundary';
import { SourceSignsSummaryChip } from '@/components/system/source-signs';
import { CommandPalette, CommandPaletteTrigger, ShortcutsHelp } from '@/components/system/command-palette';
import { MissionLogButton } from '@/components/system/mission-log';
import { GuidedTour } from '@/components/system/guided-tour';
import { cn } from '@/lib/utils';

const NAV: { key: ViewKey; label: string; short: string; icon: React.ComponentType<{ className?: string }>; group: string }[] = [
  { key: 'landing', label: 'Mission Overview', short: 'Overview', icon: Home, group: 'mission' },
  { key: 'dashboard', label: 'Earth Intelligence', short: 'Earth', icon: LayoutDashboard, group: 'intelligence' },
  { key: 'explorer', label: 'Geospatial Explorer', short: 'Explorer', icon: Map, group: 'intelligence' },
  { key: 'sources', label: 'Data Catalogue', short: 'Data', icon: Database, group: 'intelligence' },
  { key: 'analysis', label: 'Environmental Analysis', short: 'Analysis', icon: LineChart, group: 'intelligence' },
  { key: 'fire', label: 'Fire Intelligence', short: 'Fire', icon: Flame, group: 'intelligence' },
  { key: 'farm', label: 'Farm Workspace', short: 'Farms', icon: Tractor, group: 'planning' },
  { key: 'rotation', label: 'Rotation Planner', short: 'Rotation', icon: Sprout, group: 'planning' },
  { key: 'markets', label: 'Market Prices', short: 'Markets', icon: ShoppingBasket, group: 'planning' },
  { key: 'reports', label: 'Field Reports', short: 'Reports', icon: FileText, group: 'planning' },
  { key: 'organizations', label: 'Organization Workspace', short: 'Workspace', icon: Building2, group: 'enterprise' },
  { key: 'billing', label: 'Plans & Usage', short: 'Plans', icon: CreditCard, group: 'enterprise' },
  { key: 'intelligence', label: 'Atlas Intelligence', short: 'Intelligence', icon: BrainCircuit, group: 'enterprise' },
  { key: 'provenance', label: 'Evidence & Provenance', short: 'Provenance', icon: ScrollText, group: 'trust' },
  { key: 'admin', label: 'Platform Administration', short: 'Admin', icon: ShieldCheck, group: 'trust' },
  { key: 'settings', label: 'System Health', short: 'Systems', icon: Settings, group: 'trust' },
];

const GROUP_LABEL: Record<string, string> = {
  mission: 'Mission',
  intelligence: 'Earth Intelligence',
  planning: 'Field Planning',
  enterprise: 'Institution & Commerce',
  trust: 'Trust & Systems',
};

/** Ticking UTC mission clock (post-mount only to avoid hydration drift). */
function MissionClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const fmt = () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      setNow(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`);
    };
    fmt();
    const t = setInterval(fmt, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="telemetry hidden text-[11px] text-dim md:inline" suppressHydrationWarning>
      {now ?? '--:--:--Z'}
    </span>
  );
}

/** Honest link-check countdown: seconds until the next REAL system-health poll. */
function LinkCheck({ dataUpdatedAt, isFetching }: { dataUpdatedAt: number; isFetching: boolean }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((dataUpdatedAt + 120_000 - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [dataUpdatedAt]);
  return (
    <span
      className={cn('telemetry hidden items-center gap-1 whitespace-nowrap text-[10px] lg:flex', isFetching ? 'text-aqua' : 'text-faint')}
      title="Automatic system-health poll every 120 s — a real console liveness check, not live field telemetry."
      suppressHydrationWarning
    >
      {isFetching ? (
        <span className="anim-blink">chk···</span>
      ) : (
        <span>
          chk T-{left === null ? '--' : String(left).padStart(2, '0')}s
        </span>
      )}
    </span>
  );
}

/** Console-wide fire-watchlist alert chip (DB-only poll, no provider traffic;
 *  pushed digests invalidate the rows instantly — the 120 s poll is fallback). */
function FireWatchAlerts() {
  const setView = useSession((s) => s.setView);
  const { data } = useQuery({
    queryKey: ['fire-watchlists'],
    queryFn: api.watchlists,
    refetchInterval: 120_000,
    retry: 1,
    staleTime: 60_000,
  });
  const alerting = (data?.watchlists ?? []).filter((w) => w.lastStatus === 'alert');
  if (!data || alerting.length === 0) return null;
  const names = alerting.map((w) => w.name).join(' · ');
  return (
    <button
      type="button"
      onClick={() => setView('fire')}
      className="flex h-8 items-center gap-1.5 rounded-sm border border-crit/50 bg-crit/10 px-2 font-mono text-[10px] uppercase tracking-wide-mc text-crit transition-colors hover:bg-crit/20 focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ outlineColor: 'var(--nasa)' }}
      aria-label={`Fire watchlist alert: ${names}. Open Fire Intelligence.`}
      title={`Fire watchlist ALERT — ${names}`}
    >
      <FlameKindling className="h-3.5 w-3.5 anim-blink" aria-hidden />
      <span className="whitespace-nowrap">fire alert ×{alerting.length}</span>
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const locale = useLocale();
  const { view, setView, location, activeFarmId, setActiveFarmId, operator, logout } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  useConsoleHotkeys(!!operator);
  // Console-wide push channel: one EventSource keeps this console subscribed
  // to pushed watchlist digests for as long as the shell lives (reconnects
  // handled by the browser; nothing here re-renders the shell).
  useDigestStream();

  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 120_000, retry: 1 });
  const admin = useQuery({ queryKey: ['account-capabilities'], queryFn: api.capabilities, retry: false, staleTime: 60_000 });
  const farms = useQuery({ queryKey: ['farms'], queryFn: api.farms, retry: 1 });

  const groups = ['mission', 'intelligence', 'planning', 'enterprise', 'trust'];
  const navLabel = (key: ViewKey) => t(locale, `nav.${key}` as Parameters<typeof t>[1]);
  const currentLabel = (() => { const key = NAV.find((n) => n.key === view)?.key; return key ? navLabel(key) : 'Console'; })();

  const navContent = (
    <nav aria-label="Console navigation" data-tour="nav-rail" className="flex h-full flex-col gap-4 px-3 py-4">
      {/* Mission identity */}
      <div className="flex items-center gap-3 px-2 pt-1">
        <MissionPatch className="h-9 w-9 shrink-0" />
        <div className="min-w-0">
          <p className="font-display text-[13px] font-bold uppercase tracking-wide-mc text-ink">TerraField Atlas</p>
          <p className="font-mono text-[9px] uppercase tracking-mission text-nasa">Field Shift · 2026</p>
        </div>
      </div>

      <div className="mx-2 h-px bg-gradient-to-r from-nasa/50 via-edge to-transparent" aria-hidden />

      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1">
          <p className="px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-mission text-faint">
            {GROUP_LABEL[g]}
          </p>
          {NAV.filter((n) => n.group === g).filter((item) => item.key !== 'admin' || admin.data?.isAdmin === true).map((item) => {
            const active = view === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => {
                  if (!operator && item.key !== 'landing') useSession.getState().login('GUEST');
                  setView(item.key);
                  setMobileOpen(false);
                }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-nasa/10 text-ink'
                    : 'text-dim hover:bg-panel-2/70 hover:text-ink',
                )}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-nasa"
                    aria-hidden
                  />
                )}
                <Icon
                  className={cn('h-4 w-4 shrink-0', active ? 'text-nasa' : 'text-faint group-hover:text-dim')}
                  aria-hidden
                />
                <span className="truncate">{navLabel(item.key)}</span>
                {active && <ChevronRight className="ml-auto h-3 w-3 text-nasa/70" aria-hidden />}
              </button>
            );
          })}
        </div>
      ))}

      {/* Operator + sources footer */}
      <div className="mt-auto grid gap-2 border-t border-edge px-2 pt-3 pb-1">
        {operator && (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-signal anim-blink" aria-hidden />
            <p className="telemetry truncate text-[11px] text-dim">
              OPERATOR <span className="text-signal">{operator.callsign}</span>
            </p>
          </div>
        )}
        <p className="font-mono text-[9px] leading-relaxed tracking-wide text-faint">
          POWER · GIBS · EONET · FIRMS<br />
          every number traceable to source + retrieval time
        </p>
      </div>
    </nav>
  );

  const systemsNominal = health.data?.status === 'ok';

  return (
    <div className="console-shell flex min-h-screen flex-col bg-void text-dim">
      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Console rail (desktop) */}
        <aside className="console-rail sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-edge bg-sidebar lg:block">
          {navContent}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Command bar */}
          <header className="console-header sticky top-0 z-30 border-b border-edge bg-void/92 backdrop-blur supports-[backdrop-filter]:bg-void/85">
            <div className="console-command-bar flex min-h-14 flex-wrap items-center gap-3 px-4 py-2 sm:px-6">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-dim hover:bg-panel-2 hover:text-ink lg:hidden"
                    aria-label="Open console navigation"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="console-mobile-nav w-72 border-edge bg-sidebar p-0" aria-label="Console navigation">
                  <SheetTitle className="sr-only">Console navigation</SheetTitle>
                  <SheetDescription className="sr-only">
                    Mission modules: overview, earth intelligence, geospatial explorer, analysis, fire intelligence, farm workspace, rotation planner, reports, provenance and system health.
                  </SheetDescription>
                  {navContent}
                </SheetContent>
              </Sheet>

              <div className="hidden items-center gap-2 lg:flex">
                <p className="font-mono text-[10px] uppercase tracking-mission text-nasa">{currentLabel}</p>
                <ChevronRight className="h-3 w-3 text-faint" aria-hidden />
              </div>

              <div className="telemetry flex min-w-0 items-center gap-2 text-[11px]" data-tour="hdr-location">
                <span className="truncate text-dim">
                  {Math.abs(location.lat).toFixed(2)}°{location.lat >= 0 ? 'N' : 'S'} ·{' '}
                  {Math.abs(location.lon).toFixed(2)}°{location.lon >= 0 ? 'E' : 'W'}
                </span>
                <span className="hidden truncate text-faint xl:inline xl:max-w-[18rem]">{location.label}</span>
              </div>

              <div className="console-command-actions ml-auto flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto sm:gap-3">
                <OrganizationSwitcher />
                <AccountControls />
                <LocaleSwitcher />
                <span data-tour="hdr-clock" className="flex items-center">
                  <MissionClock />
                </span>
                <LinkCheck dataUpdatedAt={health.dataUpdatedAt} isFetching={health.isFetching} />

                <SourceSignsSummaryChip />

                <FireWatchAlerts />

                <button
                  type="button"
                  onClick={() => setView('settings')}
                  data-tour="hdr-health"
                  className="hidden items-center gap-1.5 rounded-sm px-1.5 py-1 transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-2 sm:flex"
                  style={{ outlineColor: 'var(--nasa)' }}
                  aria-label={`System health: ${systemsNominal ? 'nominal' : 'degraded'}`}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      health.isFetching
                        ? 'bg-aqua anim-blink'
                        : systemsNominal
                          ? 'bg-signal anim-pulse-soft'
                          : 'bg-caution anim-blink',
                    )}
                    aria-hidden
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wide-mc text-dim">
                    {health.isFetching ? 'chk' : systemsNominal ? 'sys nominal' : 'degraded'}
                  </span>
                </button>

                <div data-tour="hdr-farm">
                  <Select value={activeFarmId ?? 'none'} onValueChange={(v) => setActiveFarmId(v === 'none' ? null : v)}>
                    <SelectTrigger
                      className="h-8 w-36 border-edge bg-panel text-xs text-dim sm:w-48"
                      aria-label="Active farm"
                    >
                      <SelectValue placeholder="No active farm" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72 overflow-y-auto border-edge bg-popover text-dim">
                      <SelectItem value="none" className="text-xs">No active farm</SelectItem>
                      {(farms.data?.farms ?? []).map((f) => (
                        <SelectItem key={f.id} value={f.id} className="text-xs">
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {operator && (
                  <>
                    <span data-tour="hdr-cmdk" className="hidden sm:inline-flex">
                      <CommandPaletteTrigger />
                    </span>
                    <MissionLogButton />
                  </>
                )}

                {operator && (
                  <button
                    type="button"
                    onClick={logout}
                    className="flex h-8 items-center gap-1.5 rounded-sm border border-edge bg-panel px-2.5 text-[11px] uppercase tracking-wide-mc text-dim transition-colors hover:border-crit/50 hover:text-crit focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: 'var(--nasa)' }}
                    aria-label={`Sign out operator ${operator.callsign}`}
                    title={`Sign out ${operator.callsign}`}
                  >
                    <span className="telemetry hidden max-w-24 truncate text-signal sm:inline">{operator.callsign}</span>
                    <LogOut className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </header>

          <DegradedBanner />

          {/* Console overlays — guided tour, ⌘K command palette and ? shortcuts help */}
          <GuidedTour />
          <CommandPalette />
          <ShortcutsHelp />

          {/* Console viewport — each module is fault-isolated */}
          <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <ErrorBoundary label={currentLabel}>{children}</ErrorBoundary>
          </main>
        </div>
      </div>

      {/* Sticky mission footer */}
      <footer className="mt-auto border-t border-edge bg-sidebar">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-4 text-[11px] leading-relaxed text-faint sm:px-6 lg:px-8">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono tracking-wide">
            <span>{t(locale, 'footer.dataProviders')}</span>
            <span>{t(locale, 'footer.fireProviders')}</span>
          </div>
          <div className="text-dim/80">
            {t(locale, 'footer.missionNotice')}
          </div>
        </div>
      </footer>
    </div>
  );
}
