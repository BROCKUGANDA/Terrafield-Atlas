'use client';

import { create } from 'zustand';

/**
 * Ephemeral UI overlay state (command palette, shortcuts help, mission log).
 * Deliberately NOT persisted — overlays are transient.
 */
interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  logOpen: boolean;
  setLogOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  logOpen: false,
  setLogOpen: (logOpen) => set({ logOpen }),
}));
