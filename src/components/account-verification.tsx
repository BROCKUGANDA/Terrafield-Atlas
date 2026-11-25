'use client';

import { useEffect, useState } from 'react';

export function AccountVerification() {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('verifyAccount');
    if (!value) return;
    url.searchParams.delete('verifyAccount');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (value.length <= 256) {
      const frame = requestAnimationFrame(() => setToken(value));
      return () => cancelAnimationFrame(frame);
    }
  }, []);
  if (!token && !message) return null;
  return (
    <section role="dialog" aria-modal="true" aria-labelledby="verify-title" className="fixed inset-0 z-[100] grid place-items-center bg-background/95 p-5">
      <div className="w-full max-w-lg rounded border border-edge bg-panel p-6 sm:p-8">
        <h2 id="verify-title" className="text-xl font-semibold">Verify your account email</h2>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Confirm this one-time link to enable email-and-password sign-in. The verification token has been removed from the address bar.</p>
        {message && <p role="status" className="mt-4 text-sm">{message}</p>}
        {token && <button type="button" disabled={pending} className="mt-6 min-h-11 rounded border border-aqua px-4" onClick={async () => {
          setPending(true);
          try {
            const response = await fetch('/api/v1/account/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
            if (!response.ok) throw new Error('Verification failed. The link may be expired or already used.');
            setToken(''); setMessage('Email verified. You can now sign in.');
          } catch (error) { setMessage(error instanceof Error ? error.message : 'Verification unavailable.'); }
          finally { setPending(false); }
        }}>{pending ? 'Verifying…' : 'Verify email address'}</button>}
        <a href="/account" className="ml-4 inline-flex min-h-11 items-center underline underline-offset-4">Go to sign in</a>
      </div>
    </section>
  );
}