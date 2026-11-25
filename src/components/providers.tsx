'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { useEffect, useState } from 'react';
import { SessionControls } from '@/components/session-controls';
import { SessionProvider as AccountSessionProvider } from 'next-auth/react';
import { AccountWorkspaceBoundary } from '@/components/account-workspace-boundary';
import { AccountVerification } from '@/components/account-verification';
import { useSession as useConsoleSession } from '@/components/state/store';
import { LocaleProvider } from '@/components/locale-switcher';
import type { Locale } from '@/lib/i18n';

export function Providers({ children, locale = 'en' }: { children: React.ReactNode; locale?: Locale }) {
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
      <LocaleProvider locale={locale}>
        <AccountSessionProvider refetchInterval={300} refetchOnWindowFocus>
          <AccountWorkspaceBoundary />
          <AccountVerification />
          <MotionConfig reducedMotion="user"><SessionControls />{children}</MotionConfig>
        </AccountSessionProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}
