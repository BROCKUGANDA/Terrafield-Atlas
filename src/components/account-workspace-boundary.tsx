'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession as useAccountSession } from 'next-auth/react';
import { DEFAULT_ROTATION_DRAFTS, DEFAULT_ROTATION_PRIORITIES, useSession } from '@/components/state/store';

export function AccountWorkspaceBoundary() {
  const { data, status } = useAccountSession();
  const client = useQueryClient();
  const previous = useRef<string | undefined>(undefined);
  const identity = data?.user?.email || 'public-demo';
  useEffect(() => {
    if (status === 'loading' || previous.current === identity) return;
    if (previous.current === undefined && identity === 'public-demo') {
      previous.current = identity;
      return;
    }
    previous.current = identity;
    useSession.setState({
      privateWorkspace: identity !== 'public-demo',
      activeFarmId: null, farmBoundary: null, fireDetectionsGeoJson: null,
      rotationDrafts: DEFAULT_ROTATION_DRAFTS, rotationPriorities: DEFAULT_ROTATION_PRIORITIES,
      location: { lat: -0.28, lon: 36.07, label: 'Nakuru County — Rift Valley highlands', country: 'Kenya' },
    });
    void client.resetQueries();
  }, [identity, status, client]);
  return null;
}