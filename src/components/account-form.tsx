'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getProviders, signIn, signOut, useSession } from 'next-auth/react';
import { api } from '@/lib/api-client';

export function AccountForm() {
  const { data, status } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [google, setGoogle] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  useEffect(() => { void getProviders().then(providers => setGoogle(Boolean(providers?.google))).catch(() => undefined); }, []);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('organizationInvite');
    if (!token) return;
    const frame = requestAnimationFrame(() => setInviteToken(token));
    return () => cancelAnimationFrame(frame);
  }, []);
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
      } else {
        const result = await signIn('credentials', { email, password, redirect: false, callbackUrl: '/' });
        if (!result?.ok || result.error) throw new Error('Sign-in failed. Check your email and password, and verify your email first.');
        router.push('/#view=farm');
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Account service unavailable.'); }
    finally { setPending(false); }
  }
  if (status === 'authenticated') return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8">
      <h2 className="text-xl font-semibold">Account signed in</h2>
      <p className="mt-4 break-all text-muted-foreground">{data.user?.email}</p>
      {inviteToken && <section className="my-6 border border-aqua/40 bg-aqua/5 p-4"><h3 className="font-medium">Organization invitation</h3><p className="mt-2 text-sm text-muted-foreground">Accept this invitation to join the organization workspace. The server verifies the token, expiry, and invited email.</p><button type="button" className="mt-3 min-h-11 border border-aqua px-4" disabled={pending} onClick={async () => { setPending(true); try { const result = await api.acceptOrganizationInvitation(inviteToken); setMessage(`Invitation accepted. Role: ${result.role}.`); setInviteToken(null); const url = new URL(window.location.href); url.searchParams.delete('organizationInvite'); window.history.replaceState({}, '', url); } catch (error) { setMessage(error instanceof Error ? error.message : 'Invitation could not be accepted.'); } finally { setPending(false); } }}>{pending ? 'Accepting…' : 'Accept invitation'}</button></section>}
      <Link href="/#view=farm" className="my-6 inline-flex min-h-11 items-center rounded border px-4">Open farm workspace →</Link>
      <button type="button" className="block min-h-11 underline underline-offset-4" onClick={() => void signOut({ callbackUrl: '/account' })}>Sign out account</button>
    </section>
  );
  return (
    <section className="rounded border border-edge bg-panel p-6 sm:p-8" aria-busy={pending}>
      <h2 className="text-xl font-semibold">{mode === 'signin' ? 'Sign in securely' : 'Create a verified account'}</h2>
      <form className="mt-6 space-y-5" onSubmit={submit}>
        {mode === 'register' && <label className="block text-sm">Name<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="name" autoComplete="name" maxLength={100} required /></label>}
        <label className="block text-sm">Email<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="email" type="email" autoComplete="email" maxLength={254} required /></label>
        <label className="block text-sm">Password<input className="mt-2 min-h-11 w-full rounded border border-edge bg-background px-3" name="password" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} maxLength={128} required /></label>
        {mode === 'register' && <p className="text-xs leading-relaxed text-muted-foreground">Use a unique password of at least 12 characters. We’ll send a verification link; your password is never sent by email.</p>}
        <button type="submit" disabled={pending || status === 'loading'} className="min-h-11 w-full rounded border border-aqua bg-aqua/10 px-4 font-medium disabled:opacity-50">{pending ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Send verification email'}</button>
      </form>
      {inviteToken && <p className="mt-5 text-sm text-aqua">Sign in or create the invited account to accept your organization invitation.</p>}
      {message && <p role="status" className="mt-5 text-sm leading-relaxed">{message}</p>}
      <button type="button" className="mt-4 min-h-11 text-sm underline underline-offset-4" onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setMessage(''); }}>{mode === 'signin' ? 'Create an account' : 'Already registered? Sign in'}</button>
      {google && <button type="button" disabled={pending} onClick={() => void signIn('google', { callbackUrl: '/#view=farm' })} className="mt-3 min-h-11 w-full rounded border border-edge px-4 text-sm">Continue with Google</button>}
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Essential account cookies keep you signed in. <a href="/about" className="underline underline-offset-4">Privacy and data methodology</a></p>
    </section>
  );
}