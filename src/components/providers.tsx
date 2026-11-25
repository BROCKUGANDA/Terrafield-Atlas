'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { useEffect, useState } from 'react';
import { SessionControls } from '@/components/session-controls';
import { SessionProvider as AccountSessionProvider } from 'next-auth/react';
import { AccountWorkspaceBoundary } from '@/components/account-workspace-boundary';
import { AccountVerification } from '@/components/account-verification';
import { useSession as useConsoleSession } from '@/components/state/store';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  useEffect(() => {
    // Persisted console preferences are applied only after the first client
    // render, so server and initial client markup use the same defaults.
    void useConsoleSession.persist.rehydrate();
  }, []);

  return (
    <QueryClientProvider client={client}>
      <AccountSessionProvider refetchInterval={300} refetchOnWindowFocus>
        <AccountWorkspaceBoundary />
        <AccountVerification />
        <MotionConfig reducedMotion="user"><SessionControls />{children}</MotionConfig>
      </AccountSessionProvider>
    </QueryClientProvider>
  );
}
