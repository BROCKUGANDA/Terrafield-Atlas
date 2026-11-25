'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface OrganizationState {
  activeOrganizationId: string | null;
  setActiveOrganizationId: (id: string | null) => void;
}

/** Client-side convenience only. The server re-verifies membership on every request. */
export const useOrganizationStore = create<OrganizationState>()(
  persist(
    (set) => ({
      activeOrganizationId: null,
      setActiveOrganizationId: (activeOrganizationId) => set({ activeOrganizationId }),
    }),
    { name: 'terrafield-active-organization' },
  ),
);
