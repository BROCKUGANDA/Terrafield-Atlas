'use client';

import { AnimatePresence, motion } from 'framer-motion';
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

/**
 * Single-route console. Access model:
 *  - no operator session → the landing view presents the mission brief and
 *    the DEMO ACCESS card (one-click console login; no real credentials).
 *  - operator session → full mission console with animated module switching.
 */
export default function Home() {
  const view = useSession((s) => s.view);
  const operator = useSession((s) => s.operator);
  const activeView = operator ? view : 'landing';

  return (
    <AppShell>
      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={activeView}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {activeView === 'landing' && <LandingView />}
          {activeView === 'dashboard' && <DashboardView />}
          {activeView === 'explorer' && <ExplorerView />}
          {activeView === 'analysis' && <AnalysisView />}
          {activeView === 'farm' && <FarmWorkspaceView />}
          {activeView === 'rotation' && <RotationPlannerView />}
          {activeView === 'provenance' && <ProvenanceView />}
          {activeView === 'fire' && <FireIntelligenceView />}
          {activeView === 'reports' && <ReportsView />}
          {activeView === 'settings' && <SettingsView />}
        </motion.section>
      </AnimatePresence>
    </AppShell>
  );
}
