'use client';

import { signOut, useSession as useAccountSession } from 'next-auth/react';

export function AccountControls() {
  const { data, status } = useAccountSession();
  if (status === 'loading') return <span className="font-mono text-[10px] text-muted-foreground">Checking account…</span>;
  if (!data?.user) return <a href="/account" className="inline-flex min-h-11 items-center rounded border border-edge px-3 text-xs">Private account</a>;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <a href="/account" className="inline-flex min-h-11 max-w-36 items-center truncate underline underline-offset-4">{data.user.name || 'Private account'}</a>
      <button type="button" className="min-h-11 rounded border border-edge px-3" onClick={() => void signOut({ callbackUrl: '/' })}>Sign out account</button>
    </div>
  );
}