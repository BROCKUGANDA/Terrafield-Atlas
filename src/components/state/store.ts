'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { logEvent } from '@/components/state/log-store';

export type ViewKey =
  | 'landing'
  | 'dashboard'
  | 'explorer'
  | 'analysis'
  | 'farm'
  | 'rotation'
  | 'provenance'
  | 'fire'
  | 'reports'
  | 'settings';

export interface SelectedLocation {
  lat: number;
  lon: number;
  label: string;
  country?: string;
  context?: string;
}

/** Console operator identity. Demo-grade only: a local callsign, no credentials. */
export interface Operator {
  callsign: string;
  role: 'mission-observer';
  authenticatedAt: string;
}

/** Rotation-planner working drafts — kept in the session store so switching
 *  console modules never destroys a farmer's in-progress scenario work. */
export interface RotationDraft {
  name: string;
  cropKeys: string[];
}

export const DEFAULT_ROTATION_DRAFTS: RotationDraft[] = [
  { name: 'A: Current practice', cropKeys: ['maize', 'maize', 'maize', 'maize'] },
  { name: 'B: Legume-integrated', cropKeys: ['maize', 'cowpea', 'maize', 'common_bean'] },
  { name: 'C: Drought-hardy mix', cropKeys: ['sorghum', 'pearl_millet', 'cowpea', 'sunflower'] },
];

export const DEFAULT_ROTATION_PRIORITIES = {
  soilHealth: 0.25,
  waterEfficiency: 0.25,
  seasonalAdaptability: 0.15,
  nutrientManagement: 0.15,
  cropDiversity: 0.1,
  economics: 0,
  foodSecurity: 0.1,
};

interface SessionState {
  view: ViewKey;
  setView: (v: ViewKey) => void;
  location: SelectedLocation;
  setLocation: (loc: SelectedLocation) => void;
  activeFarmId: string | null;
  setActiveFarmId: (id: string | null) => void;
  mapDate: string; // ISO date for GIBS layers
  setMapDate: (d: string) => void;
  fireDetectionsGeoJson: GeoJSON.FeatureCollection | null;
  setFireDetectionsGeoJson: (fc: GeoJSON.FeatureCollection | null) => void;
  farmBoundary: number[][] | null; // exterior ring being drawn
  setFarmBoundary: (ring: number[][] | null) => void;
  rotationDrafts: RotationDraft[];
  setRotationDrafts: (drafts: RotationDraft[]) => void;
  rotationPriorities: typeof DEFAULT_ROTATION_PRIORITIES;
  setRotationPriorities: (p: typeof DEFAULT_ROTATION_PRIORITIES) => void;
  operator: Operator | null;
  login: (callsign: string) => void;
  logout: () => void;
}

const todayIso = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      view: 'landing',
      setView: (view) => set({ view }),
      location: { lat: -0.28, lon: 36.07, label: 'Nakuru County — Rift Valley highlands', country: 'Kenya', context: 'Highland mixed maize–dairy smallholdings; two rainy seasons' },
      setLocation: (location) => set({ location }),
      activeFarmId: null,
      setActiveFarmId: (activeFarmId) => set({ activeFarmId }),
      mapDate: todayIso,
      setMapDate: (mapDate) => set({ mapDate }),
      fireDetectionsGeoJson: null,
      setFireDetectionsGeoJson: (fireDetectionsGeoJson) => set({ fireDetectionsGeoJson }),
      farmBoundary: null,
      setFarmBoundary: (farmBoundary) => set({ farmBoundary }),
      rotationDrafts: DEFAULT_ROTATION_DRAFTS,
      setRotationDrafts: (rotationDrafts) => set({ rotationDrafts }),
      rotationPriorities: DEFAULT_ROTATION_PRIORITIES,
      setRotationPriorities: (rotationPriorities) => set({ rotationPriorities }),
      operator: null,
      login: (callsign) => {
        const cs = callsign.trim().toUpperCase() || 'GUEST';
        set({
          operator: {
            callsign: cs,
            role: 'mission-observer',
            authenticatedAt: new Date().toISOString(),
          },
          view: 'dashboard',
        });
        logEvent({
          severity: 'success',
          category: 'AUTH',
          title: `Operator session opened — ${cs}`,
          detail: 'Demo console access (local callsign, no real credentials). Session persisted for the next visit.',
          view: 'dashboard',
        });
      },
      logout: () => {
        const cs = useSession.getState().operator?.callsign ?? 'guest';
        set({ operator: null, view: 'landing' });
        logEvent({
          severity: 'info',
          category: 'AUTH',
          title: 'Operator signed out',
          detail: `Session ended for ${cs}; console state kept for the next sign-in.`,
          view: 'landing',
        });
      },
    }),
    {
      name: 'terrafield-console-session',
      partialize: (s) => ({
        operator: s.operator,
        location: s.location,
        activeFarmId: s.activeFarmId,
        rotationDrafts: s.rotationDrafts,
        rotationPriorities: s.rotationPriorities,
      }),
    },
  ),
);
