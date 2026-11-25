'use client';

import { createContext, useContext, useId, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALES, LOCALE_NAMES, isLocale, localeCookie, t, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Locale context. The root layout resolves the `tf_locale` cookie on the
 * server and passes it to `Providers`, so every client component — the console
 * landing included — renders in the same locale as the server markup.
 */
const LocaleContext = createContext<Locale>('en');

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/**
 * Persist the locale in a one-year `tf_locale` cookie (SameSite=Lax, Secure on
 * https) and refresh server components so `<html lang>`, metadata and
 * localized copy all agree. The select is a native control with an explicit
 * accessible label.
 */
export function LocaleSwitcher({
  locale: explicitLocale,
  className,
  id,
}: {
  /** Server-rendered surfaces may pass the resolved locale explicitly. */
  locale?: Locale;
  className?: string;
  id?: string;
}) {
  const contextLocale = useLocale();
  const locale = explicitLocale ?? contextLocale;
  const router = useRouter();
  const generatedId = useId();
  const selectId = id ?? `tf-locale-${generatedId}`;
  const [pending, startTransition] = useTransition();

  const label = t(locale, 'locale.label');

  const change = (next: string) => {
    if (!isLocale(next) || next === locale) return;
    document.cookie = localeCookie(next, window.location.protocol === 'https:');
    startTransition(() => router.refresh());
  };

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <label htmlFor={selectId} className="sr-only">
        {label}
      </label>
      <select
        id={selectId}
        value={locale}
        disabled={pending}
        aria-label={label}
        aria-busy={pending}
        title={label}
        onChange={(event) => change(event.target.value)}
        className="h-8 rounded-sm border border-edge bg-panel px-1.5 font-mono text-[10px] uppercase tracking-wide-mc text-dim outline-none transition-colors hover:border-nasa/50 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {LOCALE_NAMES[value]}
          </option>
        ))}
      </select>
    </div>
  );
}
