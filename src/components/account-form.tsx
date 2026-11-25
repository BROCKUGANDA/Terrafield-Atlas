'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getProviders, signIn, signOut, useSession } from 'next-auth/react';
import { api } from '@/lib/api-client';
import { useLocale } from '@/components/locale-switcher';
import { t, type TranslationKey } from '@/lib/i18n';

const BLOCKER_LABEL_KEYS: Record<string, TranslationKey> = {
  organizationsOwned: 'account.blocker.organizationsOwned',
  farmsOwned: 'account.blocker.farmsOwned',
  soleOwnerOrganizations: 'account.blocker.soleOwnerOrganizations',
  watchlistsOwned: 'account.blocker.watchlistsOwned',
  organizationInvitationsCreated: 'account.blocker.organizationInvitationsCreated',
  apiKeysCreated: 'account.blocker.apiKeysCreated',
};

export function AccountForm() {
  const { data, status } = useSession();
  const router = useRouter();
  const locale = useLocale();
  const [mode, setMode] = useState<'signin' | 'register' | 'forgot'>('signin');
  const [google, setGoogle] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const [blockers, setBlockers] = useState<Record<string, number> | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => { void getProviders().then(providers => setGoogle(Boolean(providers?.google))).catch(() => undefined); }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('organizationInvite');
    const reset = params.get('resetAccount');
    const frame = requestAnimationFrame(() => {
      if (token) setInviteToken(token);
      if (reset) setResetToken(reset);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    if (password !== String(form.get('confirmation') || '')) {
      setMessage(t(locale, 'account.passwordMismatch'));
      return;
    }
    setPending(true);
    try {
      const response = await fetch('/api/v1/account/password-reset/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password }),
      });
      if (!response.ok) { setMessage(t(locale, 'account.resetFailed')); return; }
      setResetToken(null);
      setMode('signin');
      const url = new URL(window.location.href);
      url.searchParams.delete('resetAccount');
      window.history.replaceState({}, '', url);
      setMessage(t(locale, 'account.resetSuccess'));
    } catch { setMessage(t(locale, 'account.serviceUnavailable')); }
    finally { setPending(false); }
  }
  async function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setDeleteMessage('');
    setBlockers(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/v1/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: String(form.get('password') || ''), confirmation: String(form.get('confirmation') || '') }),
      });
      const data: { error?: { code?: string; message?: string; details?: Record<string, number> } } | null = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409 && data?.error?.code === 'ACCOUNT_HAS_BLOCKERS') {
          setBlockers(data.error.details ?? {});
          setDeleteMessage(t(locale, 'account.deleteBlocked'));
          return;
        }
        const code = data?.error?.code;
        if (code === 'INVALID_PASSWORD') setDeleteMessage(t(locale, 'account.invalidPassword'));
        else if (code === 'RATE_LIMITED') setDeleteMessage(t(locale, 'account.rateLimited'));
        else setDeleteMessage(t(locale, 'account.deleteFailed'));
        return;
      }
      await signOut({ callbackUrl: '/account' });
    } catch {
      setDeleteMessage(t(locale, 'account.serviceUnavailable'));
    } finally {
      setPending(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    try {
      if (mode === 'register') {
        const response = await fetch('/api/v1/account/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, name: String(form.get('name') || '').trim() }) });
        if (!response.ok) { setMessage(t(locale, 'account.registerFailed')); return; }
        setMessage(t(locale, 'account.registerSent'));
      } else if (mode === 'forgot') {
        const response = await fetch('/api/v1/account/password-reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (!response.ok) { setMessage(t(locale, 'account.resetRequestFailed')); return; }
        setMessage(t(locale, 'account.resetRequestSent'));
      } else {
        const result = await signIn('credentials', { email, password, redirect: false, callbackUrl: '/' });
        if (!result?.ok || result.error) { setMessage(t(locale, 'account.signInFailed')); return; }
        router.push('/#view=farm');
      }
    } catch { setMessage(t(locale, 'account.serviceUnavailable')); }
    finally { setPending(false); }
  }
  if (resetToken) return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8" aria-busy={pending}>
      <h2 className="text-xl font-semibold">{t(locale, 'account.chooseNewPassword')}</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(locale, 'account.resetHelp')}</p>
      <form className="mt-6 space-y-5" onSubmit={submitReset}>
        <label className="block text-sm">{t(locale, 'account.newPassword')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <label className="block text-sm">{t(locale, 'account.confirmPassword')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <button type="submit" disabled={pending} className="min-h-11 w-full rounded border border-aqua bg-aqua/10 px-4 font-medium disabled:opacity-50">{pending ? t(locale, 'account.pleaseWait') : t(locale, 'account.updatePassword')}</button>
      </form>
      {message && <p role="status" className="mt-5 text-sm leading-relaxed">{message}</p>}
      <Link href="/account" className="mt-5 inline-flex min-h-11 items-center text-sm underline underline-offset-4">{t(locale, 'account.backToSignIn')}</Link>
    </section>
  );
  if (status === 'authenticated') return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8">
      <h2 className="text-xl font-semibold">{t(locale, 'account.signedIn')}</h2>
      <p className="mt-4 break-all text-muted-foreground">{data.user?.email}</p>
      {inviteToken && <section className="my-6 border border-aqua/40 bg-aqua/5 p-4"><h3 className="font-medium">{t(locale, 'account.inviteTitle')}</h3><p className="mt-2 text-sm text-muted-foreground">{t(locale, 'account.inviteBody')}</p><button type="button" className="mt-3 min-h-11 border border-aqua px-4" disabled={pending} onClick={async () => { setPending(true); try { const result = await api.acceptOrganizationInvitation(inviteToken); setMessage(t(locale, 'account.inviteAccepted', { role: result.role })); setInviteToken(null); const url = new URL(window.location.href); url.searchParams.delete('organizationInvite'); window.history.replaceState({}, '', url); } catch { setMessage(t(locale, 'account.inviteFailed')); } finally { setPending(false); } }}>{pending ? t(locale, 'account.inviteAccepting') : t(locale, 'account.inviteAccept')}</button></section>}
      <Link href="/#view=farm" className="my-6 inline-flex min-h-11 items-center rounded border px-4">{t(locale, 'account.openFarmWorkspace')} →</Link>
      <button type="button" className="block min-h-11 underline underline-offset-4" onClick={() => void signOut({ callbackUrl: '/account' })}>{t(locale, 'account.signOutAccount')}</button>
      <details className="mt-8 border-t border-edge pt-5">
        <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-4">{t(locale, 'account.deleteSummary')}</summary>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(locale, 'account.deleteIntro')}</p>
        <form className="mt-4 space-y-4" onSubmit={submitDelete}>
          <label className="block text-sm">{t(locale, 'account.password')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete="current-password" maxLength={1024} required /></label>
          <label className="block text-sm">{t(locale, 'account.deleteConfirmLabel')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="confirmation" autoComplete="off" pattern="DELETE" maxLength={6} required /></label>
          <button type="submit" disabled={pending} className="min-h-11 rounded border border-crit px-4 text-sm text-crit disabled:opacity-50">{pending ? t(locale, 'account.pleaseWait') : t(locale, 'account.deleteButton')}</button>
        </form>
        {blockers && Object.values(blockers).some((count) => count > 0) && (
          <ul className="mt-4 list-disc pl-5 text-sm leading-relaxed text-muted-foreground">
            {Object.entries(blockers).filter(([, count]) => count > 0).map(([key, count]) => {
              const labelKey = BLOCKER_LABEL_KEYS[key];
              return <li key={key}>{labelKey ? t(locale, labelKey) : key}: {count}</li>;
            })}
          </ul>
        )}
        {deleteMessage && <p role="status" className="mt-3 text-sm leading-relaxed">{deleteMessage}</p>}
      </details>
    </section>
  );
  return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8" aria-busy={pending}>
      <h2 className="text-xl font-semibold">{mode === 'signin' ? t(locale, 'account.signInTitle') : mode === 'register' ? t(locale, 'account.registerTitle') : t(locale, 'account.resetTitle')}</h2>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        {mode === 'register' && <label className="block text-sm">{t(locale, 'account.name')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="name" autoComplete="name" maxLength={100} required /></label>}
        <label className="block text-sm">{t(locale, 'account.email')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="email" type="email" autoComplete="email" maxLength={254} required /></label>
        {mode !== 'forgot' && <label className="block text-sm">{t(locale, 'account.password')}<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} maxLength={128} required /></label>}
        {mode === 'register' && <p className="text-xs leading-relaxed text-muted-foreground">{t(locale, 'account.registerHelp')}</p>}
        {mode === 'forgot' && <p className="text-xs leading-relaxed text-muted-foreground">{t(locale, 'account.forgotHelp')}</p>}
        <button type="submit" disabled={pending || status === 'loading'} className="min-h-11 w-full rounded border border-aqua bg-aqua/10 px-4 font-medium disabled:opacity-50">{pending ? t(locale, 'account.pleaseWait') : mode === 'signin' ? t(locale, 'account.signInButton') : mode === 'register' ? t(locale, 'account.registerButton') : t(locale, 'account.resetButton')}</button>
      </form>
      {inviteToken && <p className="mt-5 text-sm text-aqua">{t(locale, 'account.inviteSignInPrompt')}</p>}
      {message && <p role="status" className="mt-5 text-sm leading-relaxed">{message}</p>}
      {mode === 'signin' && <button type="button" className="mt-4 block min-h-11 text-sm underline underline-offset-4" onClick={() => { setMode('forgot'); setMessage(''); }}>{t(locale, 'account.forgot')}</button>}
      <button type="button" className="mt-4 min-h-11 text-sm underline underline-offset-4" onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setMessage(''); }}>{mode === 'signin' ? t(locale, 'account.createAccount') : t(locale, 'account.alreadyRegistered')}</button>
      {google && <button type="button" disabled={pending} onClick={() => void signIn('google', { callbackUrl: '/#view=farm' })} className="mt-3 min-h-11 w-full rounded border border-edge px-4 text-sm">{t(locale, 'account.google')}</button>}
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">{t(locale, 'account.helpCookies')} <a href="/about" className="underline underline-offset-4">{t(locale, 'account.privacyLink')}</a></p>
    </section>
  );
}
