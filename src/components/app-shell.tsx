'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Globe2, LayoutDashboard, Map, LineChart, Tractor, Sprout, ScrollText, Flame,
  FileText, Settings, ChevronRight, Satellite, Activity, Menu,
} from 'lucide-react';
import { useSession, type ViewKey } from '@/components/state/store';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const NAV: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; group: string }[] = [
  { key: 'landing', label: 'Overview', icon: Globe2, group: 'Product' },
  { key: 'dashboard', label: 'Earth Intelligence', icon: LayoutDashboard, group: 'Intelligence' },
  { key: 'explorer', label: 'Geospatial Explorer', icon: Map, group: 'Intelligence' },
  { key: 'analysis', label: 'Environmental Analysis', icon: LineChart, group: 'Intelligence' },
  { key: 'fire', label: 'Fire Intelligence', icon: Flame, group: 'Intelligence' },
  { key: 'farm', label: 'Farm Workspace', icon: Tractor, group: 'Planning' },
  { key: 'rotation', label: 'Rotation Planner', icon: Sprout, group: 'Planning' },
  { key: 'reports', label: 'Reports', icon: FileText, group: 'Planning' },
  { key: 'provenance', label: 'Evidence & Provenance', icon: ScrollText, group: 'Trust' },
  { key: 'settings', label: 'System Health', icon: Settings, group: 'Trust' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { view, setView, location, activeFarmId, setActiveFarmId } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 120_000,
  });
  const farms = useQuery({ queryKey: ['farms'], queryFn: api.farms });

  const groups = [...new Set(NAV.map((n) => n.group))];

  const navContent = (
    <nav aria-label="Main navigation" className="flex flex-col gap-5 px-3 py-4">
      <div className="px-2 flex items-center gap-2">
        <Satellite className="h-6 w-6 text-emerald-400" aria-hidden />
        <div>
          <div className="text-sm font-semibold tracking-wide text-slate-100">TerraField Atlas</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">NASA Earth Intelligence</div>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-0.5">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-slate-600">{g}</div>
          {NAV.filter((n) => n.group === g).map((item) => {
            const active = view === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => {
                  setView(item.key);
                  setMobileOpen(false);
                }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                  active
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
                {active && <ChevronRight className="ml-auto h-3.5 w-3.5" aria-hidden />}
              </button>
            );
          })}
        </div>
      ))}
      <div className="mt-auto px-2 py-3 text-[10px] leading-relaxed text-slate-600 border-t border-slate-800">
        NASA POWER · GIBS MODIS/VIIRS · SMAP · SoilGrids<br />
        Every number traceable to source + retrieval time.
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#060b14] text-slate-200">
      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-60 shrink-0 border-r border-slate-800 bg-[#0a101c] sticky top-0 h-screen overflow-y-auto">
          {navContent}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="sticky top-0 z-30 border-b border-slate-800 bg-[#0a101c]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0a101c]/80">
            <div className="flex h-14 items-center gap-3 px-4">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="lg:hidden text-slate-300" aria-label="Open navigation">
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-64 bg-[#0a101c] border-slate-800 p-0">
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  {navContent}
                </SheetContent>
              </Sheet>

              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="hidden sm:inline text-slate-400">{NAV.find((n) => n.key === view)?.label}</span>
                <ChevronRight className="hidden sm:inline h-3 w-3" aria-hidden />
                <span className="font-mono text-slate-300 truncate max-w-[45vw]">
                  {location.lat.toFixed(2)}°, {location.lon.toFixed(2)}°
                </span>
                <span className="hidden md:inline truncate text-slate-500 max-w-[20rem]">{location.label}</span>
              </div>

              <div className="ml-auto flex items-center gap-2">
                <Link
                  href="#system-health"
                  onClick={() => setView('settings')}
                  className="hidden sm:flex items-center gap-1.5"
                  aria-label="System health"
                >
                  <Activity className={cn('h-3.5 w-3.5', health.data?.status === 'ok' ? 'text-emerald-400' : 'text-amber-400')} aria-hidden />
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">
                    {health.isFetching ? 'checking…' : health.data?.status === 'ok' ? 'systems nominal' : 'degraded'}
                  </span>
                </Link>
                <Select
                  value={activeFarmId ?? 'none'}
                  onValueChange={(v) => setActiveFarmId(v === 'none' ? null : v)}
                >
                  <SelectTrigger className="h-8 w-[9.5rem] sm:w-52 text-xs bg-slate-900 border-slate-700" aria-label="Active farm">
                    <SelectValue placeholder="No active farm" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-900 border-slate-700 max-h-72 overflow-y-auto">
                    <SelectItem value="none" className="text-xs">No active farm</SelectItem>
                    {(farms.data?.farms ?? []).map((f) => (
                      <SelectItem key={f.id} value={f.id} className="text-xs">
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </header>

          <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-slate-800 bg-[#0a101c]">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 flex flex-col gap-2 text-[11px] text-slate-500">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>Data: NASA POWER (LaRC) · NASA GIBS EOSDIS · ISRIC SoilGrids 2.0 (CC BY 4.0)</span>
            <span>VIIRS/MODIS active-fire detections via GIBS (FIRMS detection stream)</span>
          </div>
          <div className="text-slate-600">
            TerraField Atlas · NASA Space Apps Challenge 2026 · Environmental associations are not evidence of agricultural causation; no yield or profit predictions.
          </div>
        </div>
      </footer>
    </div>
  );
}
