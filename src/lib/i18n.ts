/**
 * TerraField Atlas localization primitives.
 *
 * Supported locales: English (`en`) and Swahili (`sw`). The locale is stored
 * in the `tf_locale` cookie (one year, SameSite=Lax) and can be overridden per
 * request with the `lang` (or legacy `locale`) query parameter. Server layouts
 * resolve it and mirror it into `<html lang>`; client components receive it
 * through the `LocaleProvider` in `@/components/locale-switcher`.
 *
 * Scientific and provider-attribution strings that must match the source
 * record verbatim are intentionally NOT translated. They are enumerated in
 * `UNTRANSLATED_KEYS`, and every dictionary must carry the identical English
 * value for them (verified by `dictionaryParity`).
 */

export const LOCALES = ['en', 'sw'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie name read by the server layout and written by the locale switcher. */
export const LOCALE_COOKIE = 'tf_locale';
/** One year, in seconds — mirrors the switcher's cookie lifetime. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** BCP-47 tags used for `Intl` formatting. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-US',
  sw: 'sw-KE',
};

/** Native language names are the same in every locale. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  sw: 'Kiswahili',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale] ?? LOCALE_TAGS[DEFAULT_LOCALE];
}

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

const en = {
  'brand.name': 'TerraField Atlas',

  'locale.label': 'Language',
  'locale.english': 'English',
  'locale.swahili': 'Kiswahili',

  // Navigation / view names for every existing console view.
  'nav.landing': 'Mission Overview',
  'nav.dashboard': 'Earth Intelligence',
  'nav.explorer': 'Geospatial Explorer',
  'nav.sources': 'Data Catalogue',
  'nav.analysis': 'Environmental Analysis',
  'nav.fire': 'Fire Intelligence',
  'nav.farm': 'Farm Workspace',
  'nav.rotation': 'Rotation Planner',
  'nav.markets': 'Markets',
  'nav.reports': 'Field Reports',
  'nav.organizations': 'Organization Workspace',
  'nav.billing': 'Plans & Usage',
  'nav.intelligence': 'Atlas Intelligence',
  'nav.provenance': 'Evidence & Provenance',
  'nav.admin': 'Platform Administration',
  'nav.settings': 'System Health',
  'nav.group.mission': 'Mission',
  'nav.group.intelligence': 'Earth Intelligence',
  'nav.group.planning': 'Field Planning',
  'nav.group.enterprise': 'Institution & Commerce',
  'nav.group.trust': 'Trust & Systems',
  'nav.console': 'Console',

  // Console landing hero (marketing home).
  'landing.kicker': 'NASA Space Apps 2026 · Field Shift',
  'landing.heroSr': '— TerraField Atlas mission console',
  'landing.heroIntro':
    'Earth-observation intelligence for agricultural resilience. See what NASA satellites observe about your land — rainfall, temperature, solar radiation, root-zone moisture, vegetation and fire history — understand whether changes are statistically meaningful, and compare evidence-supported crop-rotation options with every score explainable and every observation traceable to its source.',
  'landing.cta': 'Enter console',
  'landing.accessGranted': 'Access granted',
  'landing.missionObserver': '/ mission-observer',
  'landing.returnToConsole': 'Return to console',
  'landing.signOut': 'Sign out',
  'landing.sessionNote':
    'Session identifier stays on this device. No credentials, no password, nothing transmitted.',
  'landing.consoleAccess': 'Console access — open demo',
  'landing.callsignLabel': 'Operator callsign (optional)',
  'landing.callsignPlaceholder': 'e.g. MKUL-7',
  'landing.continueAsGuest': 'Continue as guest',
  'landing.accessNote':
    'Open demo — session identifier stays on this device. No credentials, no password, nothing transmitted.',
  'landing.liveTelemetry': 'Live telemetry network',
  'landing.stylizedNotImagery': 'stylized · not imagery',
  'landing.initializing': 'initializing telemetry renderer…',
  'landing.demoPreset': 'demo preset',
  'landing.stylizedNote': 'stylized telemetry network — not an imagery product',
  'landing.sourceRegistry': 'Source registry',
  'landing.systemStatus': 'System status',

  // Account access page + account form labels (form is localized separately).
  'account.kicker': 'TerraField Atlas / Account access',
  'account.titleLine1': 'Your evidence.',
  'account.titleLine2': 'Your workspace.',
  'account.intro':
    'A verified account is separate from the public demo callsign. Account-owned farms and watchlists are checked on the server, not protected by a browser label.',
  'account.detail':
    'Private accounts support farm records, POWER ingestion, historical analysis, soil tests, rotation scenarios and reports. Private watchlists support evaluation, backtesting, scheduling and owner-only live digests. Shared email and webhook destinations never receive private alerts. Provider availability and archive coverage still apply.',
  'account.continueDemo': 'Continue with the shared public demo',
  'account.signIn': 'Sign in',
  'account.register': 'Register',
  'account.reset': 'Reset password',
  'account.name': 'Name',
  'account.email': 'Email',
  'account.password': 'Password',
  'account.newPassword': 'New password',
  'account.confirmPassword': 'Confirm password',
  'account.signInTitle': 'Sign in securely',
  'account.registerTitle': 'Create a verified account',
  'account.resetTitle': 'Reset your password',
  'account.signInButton': 'Sign in',
  'account.registerButton': 'Send verification email',
  'account.resetButton': 'Send reset email',
  'account.forgot': 'Forgot password?',
  'account.createAccount': 'Create an account',
  'account.alreadyRegistered': 'Already registered? Sign in',
  'account.google': 'Continue with Google',
  'account.pleaseWait': 'Please wait…',
  'account.helpCookies': 'Essential account cookies keep you signed in.',
  'account.privacyLink': 'Privacy and data methodology',
  'account.signedIn': 'Account signed in',
  'account.backToSignIn': 'Back to sign in',
  'account.updatePassword': 'Update password',
  'account.resetHelp':
    'This single-use link expires one hour after it was sent. Your new password must be at least 12 characters.',
  'account.registerHelp':
    'Use a unique password of at least 12 characters. We’ll send a verification link; your password is never sent by email.',
  'account.forgotHelp':
    'We’ll email a single-use reset link to a verified account. The message is the same whether or not the address is registered.',

  // Marketing shell (header, CTA, footer notice).
  'marketing.nav.platform': 'Platform',
  'marketing.nav.solutions': 'Solutions',
  'marketing.nav.dataMethodology': 'Data & methodology',
  'marketing.nav.pricing': 'Pricing',
  'marketing.nav.api': 'API',
  'marketing.nav.research': 'Research',
  'marketing.nav.contact': 'Contact',
  'marketing.nav.about': 'About',
  'marketing.nav.industries': 'Industries',
  'marketing.nav.openapi': 'OpenAPI specification',
  'marketing.nav.privacy': 'Privacy',
  'marketing.nav.terms': 'Terms',
  'marketing.nav.licensing': 'Licensing & limitations',
  'marketing.homeLabel': 'TerraField Atlas home',
  'marketing.navLabel': 'Marketing navigation',
  'marketing.cta': 'Open console',
  'marketing.tagline':
    'Earth observation into explainable operational intelligence for agriculture, resilience, and institutional planning.',
  'marketing.motto': 'Evidence before inference · provenance before presentation',
  'marketing.footerNotice':
    'No NASA endorsement or partnership is claimed. Environmental associations are not proof of agricultural causation.',

  // Shared footer / hand-off notices.
  'footer.referenceLink': 'Data sources, methodology, privacy & frequently asked questions',
  'footer.referenceSummary': 'Mission questions and evidence limits',
  'footer.dataProviders': 'DATA — NASA POWER (LaRC) · NASA GIBS EOSDIS · ISRIC SoilGrids 2.0 (CC BY 4.0)',
  'footer.fireProviders': 'VIIRS/MODIS ACTIVE-FIRE DETECTIONS VIA GIBS (FIRMS DETECTION STREAM)',
  'footer.missionNotice':
    'TerraField Atlas · NASA Space Apps Challenge 2026 · Environmental associations are not evidence of agricultural causation; no yield or profit predictions.',

  // Shared error / empty strings used on the surfaces above.
  'common.error': 'Something went wrong.',
  'common.retry': 'Try again',
  'common.empty': 'No results.',
  'common.unavailable': 'Not available.',
  'common.loading': 'Loading…',
  'common.pleaseWait': 'Please wait…',
  'common.resultsCount': '{count} results',
} as const;

export type TranslationKey = keyof typeof en;

const sw: Record<TranslationKey, string> = {
  'brand.name': 'TerraField Atlas',

  'locale.label': 'Lugha',
  'locale.english': 'English',
  'locale.swahili': 'Kiswahili',

  'nav.landing': 'Muhtasari wa Misheni',
  'nav.dashboard': 'Maarifa ya Dunia',
  'nav.explorer': 'Kichunguzi cha Kijiografia',
  'nav.sources': 'Katalogi ya Data',
  'nav.analysis': 'Uchambuzi wa Mazingira',
  'nav.fire': 'Maarifa ya Moto',
  'nav.farm': 'Eneo la Kazi la Shamba',
  'nav.rotation': 'Mpangaji wa Mzunguko wa Mazao',
  'nav.markets': 'Masoko',
  'nav.reports': 'Ripoti za Shamba',
  'nav.organizations': 'Eneo la Kazi la Taasisi',
  'nav.billing': 'Mipango na Matumizi',
  'nav.intelligence': 'Maarifa ya Atlas',
  'nav.provenance': 'Ushahidi na Chanzo',
  'nav.admin': 'Utawala wa Jukwaa',
  'nav.settings': 'Afya ya Mfumo',
  'nav.group.mission': 'Misheni',
  'nav.group.intelligence': 'Maarifa ya Dunia',
  'nav.group.planning': 'Mipango ya Shamba',
  'nav.group.enterprise': 'Taasisi na Biashara',
  'nav.group.trust': 'Uaminifu na Mifumo',
  'nav.console': 'Konsoli',

  'landing.kicker': 'NASA Space Apps 2026 · Field Shift',
  'landing.heroSr': '— konsoli ya misheni ya TerraField Atlas',
  'landing.heroIntro':
    'Ufahamu wa uchunguzi wa Dunia kwa ustahimilivu wa kilimo. Tazama kile satelaiti za NASA zinachokiona kuhusu ardhi yako — mvua, halijoto, mionzi ya jua, unyevu wa eneo la mizizi, mimea na historia ya moto — elewa kama mabadiliko ni muhimu kitakwimu, na linganisha chaguo za mzunguko wa mazao zinazoungwa mkono na ushahidi huku kila alama ikielezeka na kila uchunguzi ukifuatilika hadi chanzo chake.',
  'landing.cta': 'Ingia kwenye konsoli',
  'landing.accessGranted': 'Ufikiaji umeruhusiwa',
  'landing.missionObserver': '/ mwangalizi wa misheni',
  'landing.returnToConsole': 'Rudi kwenye konsoli',
  'landing.signOut': 'Toka',
  'landing.sessionNote':
    'Kitambulisho cha kipindi kinabaki kwenye kifaa hiki. Hakuna vitambulisho, hakuna nenosiri, hakuna kinachotumwa.',
  'landing.consoleAccess': 'Ufikiaji wa konsoli — fungua onyesho',
  'landing.callsignLabel': 'Jina la wito la mwendeshaji (si lazima)',
  'landing.callsignPlaceholder': 'mf. MKUL-7',
  'landing.continueAsGuest': 'Endelea kama mgeni',
  'landing.accessNote':
    'Onyesho wazi — kitambulisho cha kipindi kinabaki kwenye kifaa hiki. Hakuna vitambulisho, hakuna nenosiri, hakuna kinachotumwa.',
  'landing.liveTelemetry': 'Mtandao wa telemetria unaoendelea',
  'landing.stylizedNotImagery': 'imechorwa · si picha',
  'landing.initializing': 'inaandaa kionyeshi cha telemetria…',
  'landing.demoPreset': 'chaguo la onyesho',
  'landing.stylizedNote': 'mtandao wa telemetria uliochorwa — si bidhaa ya picha',
  'landing.sourceRegistry': 'Sajili ya vyanzo',
  'landing.systemStatus': 'Hali ya mfumo',

  'account.kicker': 'TerraField Atlas / Ufikiaji wa akaunti',
  'account.titleLine1': 'Ushahidi wako.',
  'account.titleLine2': 'Eneo lako la kazi.',
  'account.intro':
    'Akaunti iliyothibitishwa ni tofauti na jina la wito la onyesho la umma. Mashamba na orodha za ufuatiliaji zinazomilikiwa na akaunti hukaguliwa kwenye seva, si kulindwa na lebo ya kivinjari.',
  'account.detail':
    'Akaunti za kibinafsi zinaunga mkono kumbukumbu za shamba, uingizaji wa POWER, uchambuzi wa kihistoria, vipimo vya udongo, mifumo ya mzunguko na ripoti. Orodha za ufuatiliaji za kibinafsi zinaunga mkono tathmini, upimaji wa nyuma, ratiba na muhtasari wa moja kwa moja kwa mmiliki pekee. Maeneo ya barua pepe na webhook yanayoshirikiwa hayapokei arifa za kibinafsi. Upatikanaji wa mtoa huduma na ufikiaji wa kumbukumbu bado unatumika.',
  'account.continueDemo': 'Endelea na onyesho la umma linaloshirikiwa',
  'account.signIn': 'Ingia',
  'account.register': 'Sajili',
  'account.reset': 'Weka upya nenosiri',
  'account.name': 'Jina',
  'account.email': 'Barua pepe',
  'account.password': 'Nenosiri',
  'account.newPassword': 'Nenosiri jipya',
  'account.confirmPassword': 'Thibitisha nenosiri',
  'account.signInTitle': 'Ingia kwa usalama',
  'account.registerTitle': 'Unda akaunti iliyothibitishwa',
  'account.resetTitle': 'Weka upya nenosiri lako',
  'account.signInButton': 'Ingia',
  'account.registerButton': 'Tuma barua pepe ya uthibitisho',
  'account.resetButton': 'Tuma barua pepe ya kuweka upya',
  'account.forgot': 'Umesahau nenosiri?',
  'account.createAccount': 'Unda akaunti',
  'account.alreadyRegistered': 'Umeshasajiliwa? Ingia',
  'account.google': 'Endelea na Google',
  'account.pleaseWait': 'Tafadhali subiri…',
  'account.helpCookies': 'Vidakuzi muhimu vya akaunti vinakuweka umeingia.',
  'account.privacyLink': 'Faragha na mbinu za data',
  'account.signedIn': 'Akaunti imeingia',
  'account.backToSignIn': 'Rudi kuingia',
  'account.updatePassword': 'Sasisha nenosiri',
  'account.resetHelp':
    'Kiungo hiki cha matumizi ya mara moja kinaisha saa moja baada ya kutumwa. Nenosiri lako jipya lazima liwe na angalau herufi 12.',
  'account.registerHelp':
    'Tumia nenosiri la kipekee la angalau herufi 12. Tutatuma kiungo cha uthibitisho; nenosiri lako halitumwi kwa barua pepe.',
  'account.forgotHelp':
    'Tutatuma kiungo cha kuweka upya cha matumizi ya mara moja kwa akaunti iliyothibitishwa. Ujumbe ni ule ule ikiwa anwani imesajiliwa au la.',

  'marketing.nav.platform': 'Jukwaa',
  'marketing.nav.solutions': 'Suluhisho',
  'marketing.nav.dataMethodology': 'Data na mbinu',
  'marketing.nav.pricing': 'Bei',
  'marketing.nav.api': 'API',
  'marketing.nav.research': 'Utafiti',
  'marketing.nav.contact': 'Wasiliana',
  'marketing.nav.about': 'Kuhusu',
  'marketing.nav.industries': 'Sekta',
  'marketing.nav.openapi': 'Maelezo ya OpenAPI',
  'marketing.nav.privacy': 'Faragha',
  'marketing.nav.terms': 'Masharti',
  'marketing.nav.licensing': 'Leseni na mipaka',
  'marketing.homeLabel': 'Nyumbani kwa TerraField Atlas',
  'marketing.navLabel': 'Urambazaji wa tovuti ya masoko',
  'marketing.cta': 'Fungua konsoli',
  'marketing.tagline':
    'Uchunguzi wa Dunia unaogeuka kuwa maarifa ya utendaji yanayoelezeka kwa kilimo, ustahimilivu, na mipango ya taasisi.',
  'marketing.motto': 'Ushahidi kabla ya hitimisho · chanzo kabla ya uwasilishaji',
  'marketing.footerNotice':
    'Hakuna idhini au ushirikiano wa NASA unaodaiwa. Uhusiano wa kimazingira si uthibitisho wa sababu za kilimo.',

  'footer.referenceLink': 'Vyanzo vya data, mbinu, faragha na maswali yanayoulizwa mara kwa mara',
  'footer.referenceSummary': 'Maswali ya misheni na mipaka ya ushahidi',
  'footer.dataProviders': 'DATA — NASA POWER (LaRC) · NASA GIBS EOSDIS · ISRIC SoilGrids 2.0 (CC BY 4.0)',
  'footer.fireProviders': 'VIIRS/MODIS ACTIVE-FIRE DETECTIONS VIA GIBS (FIRMS DETECTION STREAM)',
  'footer.missionNotice':
    'TerraField Atlas · NASA Space Apps Challenge 2026 · Uhusiano wa kimazingira si ushahidi wa sababu za kilimo; hakuna utabiri wa mavuno au faida.',

  'common.error': 'Hitilafu imetokea.',
  'common.retry': 'Jaribu tena',
  'common.empty': 'Hakuna matokeo.',
  'common.unavailable': 'Haipatikani.',
  'common.loading': 'Inapakia…',
  'common.pleaseWait': 'Tafadhali subiri…',
  'common.resultsCount': '{count} matokeo',
};

export const dictionaries: Record<Locale, Readonly<Record<TranslationKey, string>>> = { en, sw };

/**
 * Keys that intentionally stay in English in every locale: product/event
 * names, acronyms and provider-attribution copy that must match the
 * scientific record verbatim. Their values must be identical across
 * dictionaries; `dictionaryParity` reports any drift.
 */
export const UNTRANSLATED_KEYS = [
  'brand.name',
  'landing.kicker',
  'marketing.nav.api',
  'footer.dataProviders',
  'footer.fireProviders',
] as const satisfies readonly TranslationKey[];

export const untranslated: ReadonlySet<string> = new Set(UNTRANSLATED_KEYS);

export function isUntranslated(key: TranslationKey): boolean {
  return untranslated.has(key);
}

// ---------------------------------------------------------------------------
// Translation + parity helper
// ---------------------------------------------------------------------------

/**
 * Translate `key` for `locale`. Unknown runtime keys fall back to English and
 * then to the key itself, so a bad call never blanks the UI.
 * `{name}` placeholders are replaced from `vars`; unresolved placeholders are
 * left intact rather than rendered as "undefined".
 */
export function t(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const dictionary = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
  const template = dictionary[key] ?? dictionaries[DEFAULT_LOCALE][key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export type ParityReport = {
  missing: string[];
  extra: string[];
  untranslatedDrift: string[];
};

/**
 * Compares every locale dictionary against English. Used by
 * `tests/i18n.test.ts`; the typed `Record<TranslationKey, string>` for `sw`
 * also makes key drift a compile error.
 */
export function dictionaryParity(locale: Locale = 'sw'): ParityReport {
  const referenceKeys = Object.keys(en) as TranslationKey[];
  const target = dictionaries[locale];
  const missing = referenceKeys.filter((key) => !(key in target));
  const extra = Object.keys(target).filter((key) => !(key in en));
  const untranslatedDrift = UNTRANSLATED_KEYS.filter((key) => target[key] !== en[key]);
  return { missing, extra, untranslatedDrift };
}

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

type NameGetter = { get(name: string): unknown };
/**
 * Any of: a raw cookie value (`sw`), a `Cookie` header string
 * (`tf_locale=sw; other=…`), a Next.js `cookies()` store / `searchParams`
 * URLSearchParams, or a plain record of query/cookie values.
 */
export type LocaleSource = string | NameGetter | Record<string, unknown> | null | undefined;

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value !== null && typeof value === 'object') {
    // Next.js `cookies().get()` returns `{ name, value }`.
    const inner: unknown = Reflect.get(value, 'value');
    if (typeof inner === 'string') return inner.trim() || null;
  }
  return null;
}

function readParam(source: LocaleSource, names: string[]): string | null {
  if (!source || typeof source === 'string') return null;
  const getter: unknown = Reflect.get(source, 'get');
  for (const name of names) {
    if (typeof getter === 'function') {
      const fetched: unknown = getter.call(source, name);
      const value = readString(fetched);
      if (value) return value;
    }
    const raw: unknown = Reflect.get(source, name);
    if (Array.isArray(raw)) {
      const first = readString(raw[0]);
      if (first) return first;
    }
    const value = readString(raw);
    if (value) return value;
  }
  return null;
}

function readCookie(source: LocaleSource): string | null {
  if (!source) return null;
  if (typeof source === 'string') {
    const direct = readString(source);
    if (direct && isLocale(direct)) return direct;
    for (const part of source.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      if (part.slice(0, separator).trim() !== LOCALE_COOKIE) continue;
      const raw = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return null;
  }
  const getter: unknown = Reflect.get(source, 'get');
  if (typeof getter === 'function') {
    const fetched: unknown = getter.call(source, LOCALE_COOKIE);
    const value = readString(fetched);
    if (value) return value;
  }
  return readString(Reflect.get(source, LOCALE_COOKIE));
}

function isSearchSource(source: LocaleSource): boolean {
  if (!source || typeof source === 'string') return false;
  // URLSearchParams is the canonical search-params shape. Next.js `cookies()`
  // stores also expose `get`/`getAll`, so they must NOT be detected by method
  // presence — only by a `lang`/`locale` record or this exact instance check.
  if (source instanceof URLSearchParams) return true;
  if (typeof Reflect.get(source, 'get') === 'function') return false;
  return Reflect.get(source, 'lang') !== undefined || Reflect.get(source, 'locale') !== undefined;
}

/**
 * Resolve the request locale.
 *
 * `resolveLocale(cookieSource)` accepts the Next.js `cookies()` store, a raw
 * `Cookie` header, a raw cookie value, or a `searchParams` object.
 * `resolveLocale(cookieSource, searchParams)` lets a page pass both — the
 * explicit `lang`/`locale` query parameter wins over the cookie.
 */
export function resolveLocale(cookieSource?: LocaleSource, searchSource?: LocaleSource): Locale {
  const querySource = searchSource ?? (isSearchSource(cookieSource) ? cookieSource : undefined);
  const cookiesOnly = searchSource ? cookieSource : isSearchSource(cookieSource) ? undefined : cookieSource;

  const fromQuery = readParam(querySource, ['lang', 'locale']);
  if (isLocale(fromQuery)) return fromQuery;

  const fromCookie = readCookie(cookiesOnly);
  if (isLocale(fromCookie)) return fromCookie;

  return DEFAULT_LOCALE;
}

/** Serialize the persistence cookie for `document.cookie`. */
export function localeCookie(locale: Locale, secure: boolean): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a date with the locale's `Intl.DateTimeFormat` tag. Defaults to a
 * medium date in UTC so server and client render identical strings.
 */
export function formatDate(
  value: Date | number | string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return t(locale, 'common.unavailable');
  return new Intl.DateTimeFormat(localeTag(locale), { timeZone: 'UTC', ...options }).format(date);
}

/** Format a number with the locale's `Intl.NumberFormat` tag. */
export function formatNumber(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}
