'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { AppShell } from '@/components/app-shell';
import { useSession } from '@/components/state/store';
import { useConsoleUrlSync } from '@/hooks/use-console-sync';
import { LandingView } from '@/components/views/landing';
const DashboardView = dynamic(() => import('@/components/views/dashboard').then((m) => m.DashboardView));
const ExplorerView = dynamic(() => import('@/components/views/explorer').then((m) => m.ExplorerView));
const SourcesView = dynamic(() => import('@/components/views/sources').then((m) => m.SourcesView));
const AnalysisView = dynamic(() => import('@/components/views/analysis').then((m) => m.AnalysisView));
const FarmWorkspaceView = dynamic(() => import('@/components/views/farm-workspace').then((m) => m.FarmWorkspaceView));
const RotationPlannerView = dynamic(() => import('@/components/views/rotation-planner').then((m) => m.RotationPlannerView));
const MarketsView = dynamic(() => import('@/components/views/markets').then((m) => m.MarketsView));
const ProvenanceView = dynamic(() => import('@/components/views/provenance').then((m) => m.ProvenanceView));
const FireIntelligenceView = dynamic(() => import('@/components/views/fire-intelligence').then((m) => m.FireIntelligenceView));
const ReportsView = dynamic(() => import('@/components/views/reports').then((m) => m.ReportsView));
const OrganizationsView = dynamic(() => import('@/components/views/organizations').then((m) => m.OrganizationsView));
const BillingView = dynamic(() => import('@/components/views/billing').then((m) => m.BillingView));
const IntelligenceView = dynamic(() => import('@/components/views/intelligence').then((m) => m.IntelligenceView));
const AdminView = dynamic(() => import('@/components/views/admin').then((m) => m.AdminView));
const SettingsView = dynamic(() => import('@/components/views/settings').then((m) => m.SettingsView));

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

  // Mirror console state (view / farm / region) into the URL fragment so an
  // exact console position is bookmarkable and shareable.
  useConsoleUrlSync(!!operator);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeView]);

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
          {activeView === 'sources' && <SourcesView />}
          {activeView === 'analysis' && <AnalysisView />}
          {activeView === 'farm' && <FarmWorkspaceView />}
          {activeView === 'rotation' && <RotationPlannerView />}
          {activeView === 'markets' && <MarketsView />}
          {activeView === 'provenance' && <ProvenanceView />}
          {activeView === 'fire' && <FireIntelligenceView />}
          {activeView === 'reports' && <ReportsView />}
          {activeView === 'organizations' && <OrganizationsView />}
          {activeView === 'billing' && <BillingView />}
          {activeView === 'intelligence' && <IntelligenceView />}
          {activeView === 'admin' && <AdminView />}
          {activeView === 'settings' && <SettingsView />}
        </motion.section>
      </AnimatePresence>
    </AppShell>
  );
}
