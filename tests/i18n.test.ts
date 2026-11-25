import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LOCALE,
  LOCALES,
  UNTRANSLATED_KEYS,
  dictionaries,
  dictionaryParity,
  formatDate,
  formatNumber,
  isLocale,
  localeCookie,
  localeTag,
  resolveLocale,
  t,
} from '@/lib/i18n';

describe('dictionary parity', () => {
  test('every English key exists in Swahili with no extras or drift', () => {
    for (const locale of LOCALES) {
      expect(dictionaryParity(locale)).toEqual({ missing: [], extra: [], untranslatedDrift: [] });
    }
  });

  test('untranslated keys are real and carry identical English values', () => {
    expect(UNTRANSLATED_KEYS.length).toBeGreaterThan(0);
    for (const key of UNTRANSLATED_KEYS) {
      expect(dictionaries.en[key]).toBeDefined();
      expect(dictionaries.sw[key]).toBe(dictionaries.en[key]);
    }
    expect(dictionaries.sw['brand.name']).toBe('TerraField Atlas');
  });

  test('Swahili genuinely translates the selected surfaces', () => {
    for (const key of ['nav.dashboard', 'nav.settings', 'account.titleLine1', 'marketing.footerNotice', 'landing.heroIntro'] as const) {
      expect(t('sw', key)).not.toBe(t('en', key));
    }
  });
});

describe('translation', () => {
  test('interpolates named variables', () => {
    expect(t('en', 'common.resultsCount', { count: 3 })).toBe('3 results');
    expect(t('sw', 'common.resultsCount', { count: 3 })).toBe('3 matokeo');
  });

  test('leaves unresolved placeholders intact rather than printing undefined', () => {
    expect(t('en', 'common.resultsCount')).toBe('{count} results');
    expect(t('en', 'common.resultsCount', { other: 1 })).toBe('{count} results');
  });

  test('English copy is unchanged', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(t('en', 'nav.landing')).toBe('Mission Overview');
    expect(t('en', 'landing.cta')).toBe('Enter console');
    expect(t('en', 'landing.heroIntro')).toBe(
      'Earth-observation intelligence for agricultural resilience. See what NASA satellites observe about your land — rainfall, temperature, solar radiation, root-zone moisture, vegetation and fire history — understand whether changes are statistically meaningful, and compare evidence-supported crop-rotation options with every score explainable and every observation traceable to its source.',
    );
    expect(t('en', 'account.continueDemo')).toBe('Continue with the shared public demo');
    expect(t('en', 'account.intro')).toBe(
      'A verified account is separate from the public demo callsign. Account-owned farms and watchlists are checked on the server, not protected by a browser label.',
    );
    expect(t('en', 'account.detail')).toBe(
      'Private accounts support farm records, POWER ingestion, historical analysis, soil tests, rotation scenarios and reports. Private watchlists support evaluation, backtesting, scheduling and owner-only live digests. Shared email and webhook destinations never receive private alerts. Provider availability and archive coverage still apply.',
    );
    expect(t('en', 'marketing.cta')).toBe('Open console');
    expect(t('en', 'marketing.footerNotice')).toBe(
      'No NASA endorsement or partnership is claimed. Environmental associations are not proof of agricultural causation.',
    );
    expect(t('en', 'footer.referenceLink')).toBe('Data sources, methodology, privacy & frequently asked questions');
    expect(t('en', 'footer.referenceSummary')).toBe('Mission questions and evidence limits');
    expect(t('en', 'landing.sessionNote')).toBe(
      'Session identifier stays on this device. No credentials, no password, nothing transmitted.',
    );
    expect(t('en', 'landing.sourceRegistry')).toBe('Source registry');
    expect(t('en', 'nav.settings')).toBe('System Health');
    expect(t('en', 'footer.missionNotice')).toBe(
      'TerraField Atlas · NASA Space Apps Challenge 2026 · Environmental associations are not evidence of agricultural causation; no yield or profit predictions.',
    );
  });

  test('every dictionary value is a non-empty string', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        expect(typeof value).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
        expect(value).toBe(value.trim());
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('locale resolution', () => {
  test('falls back to English for missing or unsupported input', () => {
    expect(resolveLocale()).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
    expect(resolveLocale('tf_locale=fr')).toBe('en');
  });

  test('reads a raw cookie value and a Cookie header', () => {
    expect(resolveLocale('sw')).toBe('sw');
    expect(resolveLocale('tf_locale=sw; theme=dark')).toBe('sw');
    expect(resolveLocale('theme=dark; tf_locale=sw')).toBe('sw');
    expect(resolveLocale('theme=dark; tf_locale=en')).toBe('en');
  });

  test('reads a Next.js cookies() store', () => {
    const store = {
      size: 1,
      get(name: string) {
        return name === 'tf_locale' ? { name, value: 'sw' } : undefined;
      },
      getAll() {
        return [{ name: 'tf_locale', value: 'sw' }];
      },
      has(name: string) {
        return name === 'tf_locale';
      },
      toString() {
        return 'tf_locale=sw';
      },
    };
    // Regression: `cookies()` also exposes getAll/has/toString, which must not
    // be mistaken for searchParams.
    expect(resolveLocale(store)).toBe('sw');
  });

  test('query parameter wins over the persisted cookie', () => {
    expect(resolveLocale('tf_locale=en', new URLSearchParams('lang=sw'))).toBe('sw');
    expect(resolveLocale('tf_locale=sw', new URLSearchParams('lang=en'))).toBe('en');
    expect(resolveLocale('tf_locale=sw', { lang: ['en'] })).toBe('en');
    expect(resolveLocale('tf_locale=en', new URLSearchParams('locale=sw'))).toBe('sw');
  });

  test('unsupported query values fall back to the cookie', () => {
    expect(resolveLocale('tf_locale=sw', new URLSearchParams('lang=fr'))).toBe('sw');
  });

  test('accepts searchParams as the sole argument', () => {
    expect(resolveLocale(new URLSearchParams('lang=sw'))).toBe('sw');
    expect(resolveLocale({ locale: 'en' })).toBe('en');
  });

  test('serializes a one-year SameSite=Lax cookie', () => {
    expect(localeCookie('sw', false)).toBe('tf_locale=sw; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(localeCookie('en', true)).toBe('tf_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  });

  test('maps locales to Intl tags', () => {
    expect(localeTag('en')).toBe('en-US');
    expect(localeTag('sw')).toBe('sw-KE');
    expect(isLocale('sw')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('formatting', () => {
  const date = new Date('2026-03-05T12:00:00Z');

  test('dates use the locale tag with deterministic UTC output', () => {
    expect(formatDate(date, 'en')).toBe('Mar 5, 2026');
    expect(formatDate(date, 'en', { dateStyle: 'long' })).toBe('March 5, 2026');
    expect(formatDate(date, 'sw')).toContain('2026');
    expect(formatDate(date, 'sw')).toBe(new Intl.DateTimeFormat('sw-KE', { dateStyle: 'medium', timeZone: 'UTC' }).format(date));
  });

  test('invalid dates render the localized unavailable string', () => {
    expect(formatDate('not-a-date', 'en')).toBe('Not available.');
    expect(formatDate('not-a-date', 'sw')).toBe('Haipatikani.');
  });

  test('numbers use the locale tag and options', () => {
    expect(formatNumber(1234.5, 'en')).toBe(new Intl.NumberFormat('en-US').format(1234.5));
    expect(formatNumber(1234.5, 'sw')).toBe(new Intl.NumberFormat('sw-KE').format(1234.5));
    expect(formatNumber(0.42, 'en', { style: 'percent' })).toBe('42%');
    expect(formatNumber(0.42, 'sw', { style: 'percent' })).toBe(new Intl.NumberFormat('sw-KE', { style: 'percent' }).format(0.42));
  });
});
