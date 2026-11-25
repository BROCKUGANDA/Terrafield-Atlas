'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getProviders, signIn, signOut, useSession } from 'next-auth/react';
import { api } from '@/lib/api-client';

const DELETE_BLOCKER_LABELS: Record<string, string> = {
  organizationsOwned: 'Organizations you own',
  farmsOwned: 'Farms you own',
  soleOwnerOrganizations: 'Organizations where you are the only owner',
  watchlistsOwned: 'Fire watchlists you own',
  organizationInvitationsCreated: 'Organization invitations you sent',
  apiKeysCreated: 'API keys you created',
};

export function AccountForm() {
  const { data, status } = useSession();
  const router = useRouter();
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
    setPending(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    try {
      if (password !== String(form.get('confirmation') || '')) throw new Error('Passwords do not match.');
      const response = await fetch('/api/v1/account/password-reset/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password }),
      });
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message || 'Password reset could not be completed.');
      setResetToken(null);
      setMode('signin');
      const url = new URL(window.location.href);
      url.searchParams.delete('resetAccount');
      window.history.replaceState({}, '', url);
      setMessage('Password updated. Sign in with your new password.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Account service unavailable.'); }
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
          setDeleteMessage(data.error.message ?? 'Resolve the listed resources before deleting this account.');
          return;
        }
        throw new Error(data?.error?.message ?? 'Account could not be deleted.');
      }
      await signOut({ callbackUrl: '/account' });
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : 'Account service unavailable.');
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
        if (!response.ok) throw new Error('Registration could not be completed. Check your details or try later.');
        setMessage('If registration is available for this address, a verification email has been sent. Verify your email before signing in.');
      } else if (mode === 'forgot') {
        const response = await fetch('/api/v1/account/password-reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
        if (!response.ok) throw new Error('Password reset could not be requested. Try again later.');
        setMessage('If a verified account exists for this address, a password-reset email has been sent.');
      } else {
        const result = await signIn('credentials', { email, password, redirect: false, callbackUrl: '/' });
        if (!result?.ok || result.error) throw new Error('Sign-in failed. Check your email and password, and verify your email first.');
        router.push('/#view=farm');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Account service unavailable.'); }
    finally { setPending(false); }
  }
  if (resetToken) return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8" aria-busy={pending}>
      <h2 className="text-xl font-semibold">Choose a new password</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">This single-use link expires one hour after it was sent. Your new password must be at least 12 characters.</p>
      <form className="mt-6 space-y-5" onSubmit={submitReset}>
        <label className="block text-sm">New password<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <label className="block text-sm">Confirm password<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <button type="submit" disabled={pending} className="min-h-11 w-full rounded border border-aqua bg-aqua/10 px-4 font-medium disabled:opacity-50">{pending ? 'Please wait…' : 'Update password'}</button>
      </form>
      {message && <p role="status" className="mt-5 text-sm leading-relaxed">{message}</p>}
      <Link href="/account" className="mt-5 inline-flex min-h-11 items-center text-sm underline underline-offset-4">Back to sign in</Link>
    </section>
  );
  if (status === 'authenticated') return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8">
      <h2 className="text-xl font-semibold">Account signed in</h2>
      <p className="mt-4 break-all text-muted-foreground">{data.user?.email}</p>
      {inviteToken && <section className="my-6 border border-aqua/40 bg-aqua/5 p-4"><h3 className="font-medium">Organization invitation</h3><p className="mt-2 text-sm text-muted-foreground">Accept this invitation to join the organization workspace. The server verifies the token, expiry, and invited email.</p><button type="button" className="mt-3 min-h-11 border border-aqua px-4" disabled={pending} onClick={async () => { setPending(true); try { const result = await api.acceptOrganizationInvitation(inviteToken); setMessage(`Invitation accepted. Role: ${result.role}.`); setInviteToken(null); const url = new URL(window.location.href); url.searchParams.delete('organizationInvite'); window.history.replaceState({}, '', url); } catch (error) { setMessage(error instanceof Error ? error.message : 'Invitation could not be accepted.'); } finally { setPending(false); } }}>{pending ? 'Accepting…' : 'Accept invitation'}</button></section>}
      <Link href="/#view=farm" className="my-6 inline-flex min-h-11 items-center rounded border px-4">Open farm workspace →</Link>
      <button type="button" className="block min-h-11 underline underline-offset-4" onClick={() => void signOut({ callbackUrl: '/account' })}>Sign out account</button>
      <details className="mt-8 border-t border-edge pt-5">
        <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-4">Delete account</summary>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Permanently erase this account and its sign-in credentials. Organizations, farms, watchlists, invitations or API keys you still own must be transferred or removed first.</p>
        <form className="mt-4 space-y-4" onSubmit={submitDelete}>
          <label className="block text-sm">Password<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete="current-password" maxLength={1024} required /></label>
          <label className="block text-sm">Type DELETE to confirm<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="confirmation" autoComplete="off" pattern="DELETE" maxLength={6} required /></label>
          <button type="submit" disabled={pending} className="min-h-11 rounded border border-crit px-4 text-sm text-crit disabled:opacity-50">{pending ? 'Please wait…' : 'Delete account permanently'}</button>
        </form>
        {blockers && Object.values(blockers).some((count) => count > 0) && (
          <ul className="mt-4 list-disc pl-5 text-sm leading-relaxed text-muted-foreground">
            {Object.entries(blockers).filter(([, count]) => count > 0).map(([key, count]) => (
              <li key={key}>{DELETE_BLOCKER_LABELS[key] ?? key}: {count}</li>
            ))}
          </ul>
        )}
        {deleteMessage && <p role="status" className="mt-3 text-sm leading-relaxed">{deleteMessage}</p>}
      </details>
    </section>
  );
  return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8" aria-busy={pending}>
      <h2 className="text-xl font-semibold">{mode === 'signin' ? 'Sign in securely' : mode === 'register' ? 'Create a verified account' : 'Reset your password'}</h2>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        {mode === 'register' && <label className="block text-sm">Name<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="name" autoComplete="name" maxLength={100} required /></label>}
        <label className="block text-sm">Email<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="email" type="email" autoComplete="email" maxLength={254} required /></label>
        {mode !== 'forgot' && <label className="block text-sm">Password<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} maxLength={128} required /></label>}
        {mode === 'register' && <p className="text-xs leading-relaxed text-muted-foreground">Use a unique password of at least 12 characters. We’ll send a verification link; your password is never sent by email.</p>}
        {mode === 'forgot' && <p className="text-xs leading-relaxed text-muted-foreground">We’ll email a single-use reset link to a verified account. The message is the same whether or not the address is registered.</p>}
        <button type="submit" disabled={pending || status === 'loading'} className="min-h-11 w-full rounded border border-aqua bg-aqua/10 px-4 font-medium disabled:opacity-50">{pending ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'register' ? 'Send verification email' : 'Send reset email'}</button>
      </form>
      {inviteToken && <p className="mt-5 text-sm text-aqua">Sign in or create the invited account to accept your organization invitation.</p>}
      {message && <p role="status" className="mt-5 text-sm leading-relaxed">{message}</p>}
      {mode === 'signin' && <button type="button" className="mt-4 block min-h-11 text-sm underline underline-offset-4" onClick={() => { setMode('forgot'); setMessage(''); }}>Forgot password?</button>}
      <button type="button" className="mt-4 min-h-11 text-sm underline underline-offset-4" onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setMessage(''); }}>{mode === 'signin' ? 'Create an account' : 'Already registered? Sign in'}</button>
      {google && <button type="button" disabled={pending} onClick={() => void signIn('google', { callbackUrl: '/#view=farm' })} className="mt-3 min-h-11 w-full rounded border border-edge px-4 text-sm">Continue with Google</button>}
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Essential account cookies keep you signed in. <a href="/about" className="underline underline-offset-4">Privacy and data methodology</a></p>
    </section>
  );
}