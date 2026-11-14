'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
      operator: null,
      login: (callsign) =>
        set({
          operator: {
            callsign: callsign.trim().toUpperCase() || 'GUEST',
            role: 'mission-observer',
            authenticatedAt: new Date().toISOString(),
          },
          view: 'dashboard',
        }),
      logout: () => set({ operator: null, view: 'landing' }),
    }),
    {
      name: 'terrafield-console-session',
      partialize: (s) => ({ operator: s.operator, location: s.location }),
    },
  ),
);
