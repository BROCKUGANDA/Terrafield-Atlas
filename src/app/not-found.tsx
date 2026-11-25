import Link from 'next/link';

/**
 * 404 for any unmapped route — same honesty rules as the rest of the console:
 * state what is missing, offer the real paths back.
 */
export default function NotFound() {
  return (
    <div className="mx-auto my-16 w-full max-w-xl hud hud-calm anim-fade-up p-8 text-center">
      <p className="kicker text-nasa">Telemetry route not found</p>
      <h1 className="mt-2 font-display text-xl font-bold uppercase tracking-wide-mc text-ink">404 — no console module at this address</h1>
      <p className="mt-3 text-sm leading-relaxed text-faint">
        The URL does not map to any TerraField Atlas module. Nothing was substituted for it; the console
        lives at the root route.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex h-9 items-center rounded-sm border border-nasa/50 bg-nasa/10 px-4 text-xs font-semibold uppercase tracking-wide-mc text-ink transition-colors hover:bg-nasa/20"
      >
        Return to mission console
      </Link>
    </div>
  );
}
