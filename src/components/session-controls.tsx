'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/state/store';

export function SessionControls() {
  const operator = useSession((s) => s.operator);
  const [notice, setNotice] = useState(false);
  const [fault, setFault] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { setNotice(localStorage.getItem('terrafield-privacy-notice') !== 'seen'); }
      catch { setNotice(true); }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!operator) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    if (operator) {
      const age = Date.now() - Date.parse(operator.authenticatedAt);
      if (!Number.isFinite(age) || age >= 8 * 60 * 60 * 1000) {
        useSession.getState().logout();
        return;
      }
      timer = setTimeout(() => useSession.getState().logout(), 8 * 60 * 60 * 1000 - Math.max(0, age));
    }
    fetch('/api/v1/session', { method: 'POST', signal: controller.signal })
      .then((res) => { if (!res.ok) throw new Error('Session unavailable'); setFault(false); })
      .catch(() => { if (!controller.signal.aborted) setFault(true); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [operator]);

  if (!notice && !fault) return null;
  return (
    <aside aria-label="Session and privacy information" className="relative z-30 border-b border-white/10 bg-slate-950 px-4 py-3 text-xs text-slate-300">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-64">{fault ? 'Demo-session service unavailable. The demo callsign is not an authenticated account.' : 'Essential session cookies only; no advertising cookies. Public-demo preferences and drafts use browser storage. Private workspace drafts stay in memory and reset on account changes. Sessions expire after 8 hours.'} <a href="/about" className="underline underline-offset-4">Data & privacy</a></p>
        {notice && <button type="button" className="min-h-11 rounded border border-white/20 px-4" onClick={() => {
          try { localStorage.setItem('terrafield-privacy-notice', 'seen'); } catch { /* Storage is optional. */ }
          setNotice(false);
        }}>Understood</button>}
      </div>
    </aside>
  );
}