import Link from 'next/link';
import type { ReactNode } from 'react';

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-void/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label="TerraField Atlas home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={36} height={36} className="h-9 w-9" />
          <span className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">TerraField Atlas</span>
        </Link>
        <nav aria-label="Marketing navigation" className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-dim">
          <Link href="/platform" className="hover:text-ink">Platform</Link>
          <Link href="/solutions" className="hover:text-ink">Solutions</Link>
          <Link href="/data-methodology" className="hover:text-ink">Data & methodology</Link>
          <Link href="/pricing" className="hover:text-ink">Pricing</Link>
          <Link href="/developers" className="hover:text-ink">API</Link>
          <Link href="/research" className="hover:text-ink">Research</Link>
          <Link href="/contact" className="hover:text-ink">Contact</Link>
        </nav>
        <Link href="/#view=dashboard" className="inline-flex min-h-10 items-center border border-nasa/50 bg-nasa/10 px-4 font-mono text-[10px] uppercase tracking-wide-mc text-ink hover:bg-nasa/20">Open console</Link>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-edge bg-sidebar">
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 sm:px-8 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <p className="font-display text-sm font-bold uppercase tracking-wide-mc text-ink">TerraField Atlas</p>
          <p className="mt-3 max-w-md text-xs leading-relaxed text-dim">Earth observation into explainable operational intelligence for agriculture, resilience, and institutional planning.</p>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-wide-mc text-faint">Evidence before inference · provenance before presentation</p>
        </div>
        <div className="grid gap-2 text-xs text-dim">
          <Link href="/about" className="hover:text-ink">About</Link>
          <Link href="/industries" className="hover:text-ink">Industries</Link>
          <Link href="/contact" className="hover:text-ink">Contact</Link>
          <Link href="/api/v1/openapi.json" className="hover:text-ink">OpenAPI specification</Link>
        </div>
        <div className="grid gap-2 text-xs text-dim">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/data-methodology" className="hover:text-ink">Licensing & limitations</Link>
          <a href="mailto:contact@terrafieldatlas.us" className="hover:text-ink">contact@terrafieldatlas.us</a>
        </div>
      </div>
      <div className="border-t border-edge px-5 py-4 text-center font-mono text-[9px] uppercase tracking-wide-mc text-faint">No NASA endorsement or partnership is claimed. Environmental associations are not proof of agricultural causation.</div>
    </footer>
  );
}

export function MarketingPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-void text-dim">
      <MarketingHeader />
      <main>{children}</main>
      <MarketingFooter />
    </div>
  );
}

export function PageHero({ kicker, title, description }: { kicker: string; title: string; description: string }) {
  return (
    <section className="relative overflow-hidden border-b border-edge">
      <div className="absolute inset-0 grid-bg opacity-60" aria-hidden />
      <div className="relative mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-24">
        <p className="kicker">{kicker}</p>
        <h1 className="mt-5 max-w-4xl font-display text-4xl font-bold leading-tight text-ink sm:text-6xl">{title}</h1>
        <p className="mt-6 max-w-3xl text-base leading-relaxed text-dim sm:text-lg">{description}</p>
      </div>
    </section>
  );
}

export function ContentSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto max-w-7xl px-5 py-14 sm:px-8">
      <h2 className="font-display text-2xl font-bold uppercase tracking-wide-mc text-ink sm:text-3xl">{title}</h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function FeatureCard({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <article className="hud hud-calm flex flex-col gap-3 p-5">
      <span className="telemetry text-xs text-nasa">{index}</span>
      <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
      <div className="text-sm leading-relaxed text-dim">{children}</div>
    </article>
  );
}
