'use client';

import { AppShell } from '@/components/app-shell';
import { useSession } from '@/components/state/store';
import { LandingView } from '@/components/views/landing';
import { DashboardView } from '@/components/views/dashboard';
import { ExplorerView } from '@/components/views/explorer';
import { AnalysisView } from '@/components/views/analysis';
import { FarmWorkspaceView } from '@/components/views/farm-workspace';
import { RotationPlannerView } from '@/components/views/rotation-planner';
import { ProvenanceView } from '@/components/views/provenance';
import { FireIntelligenceView } from '@/components/views/fire-intelligence';
import { ReportsView } from '@/components/views/reports';
import { SettingsView } from '@/components/views/settings';

export default function Home() {
  const view = useSession((s) => s.view);
  return (
    <AppShell>
      {view === 'landing' && <LandingView />}
      {view === 'dashboard' && <DashboardView />}
      {view === 'explorer' && <ExplorerView />}
      {view === 'analysis' && <AnalysisView />}
      {view === 'farm' && <FarmWorkspaceView />}
      {view === 'rotation' && <RotationPlannerView />}
      {view === 'provenance' && <ProvenanceView />}
      {view === 'fire' && <FireIntelligenceView />}
      {view === 'reports' && <ReportsView />}
      {view === 'settings' && <SettingsView />}
    </AppShell>
  );
}
