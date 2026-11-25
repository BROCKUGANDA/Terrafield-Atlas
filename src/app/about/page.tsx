import type { Metadata } from 'next';
import Link from 'next/link';
import { MODULE_GUIDES } from '@/lib/module-guides';

export const metadata: Metadata = {
  title: 'Data, Methodology & Privacy',
  description: 'How TerraField Atlas uses NASA Earth observations, what the evidence can and cannot tell you, and how demo sessions and cookies work.',
  alternates: { canonical: '/about' },
};

const answers = [
  ['What is TerraField Atlas?', 'A public Earth-observation mission console for agricultural resilience: explore satellite imagery, inspect environmental records, compare crop rotations and monitor fire context.'],
  ['Where does the data come from?', 'NASA POWER supplies daily meteorology. NASA GIBS supplies satellite imagery and VIIRS thermal anomalies. NASA EONET supplies reported natural-event context. SoilGrids supplies modelled soil estimates, not laboratory measurements. Provider availability, observation times and provenance must be checked in the console.'],
  ['Is the globe instantaneous?', 'No. The globe periodically refreshes reported NASA EONET events. Event timestamps are observation/report times, not a guarantee of current conditions. A thermal anomaly or event marker is not a verified fire perimeter or emergency warning.'],
  ['What can the analysis establish?', 'The console evaluates historical environmental evidence and crop-rotation suitability. Statistical trend claims require sufficient records; missing data must remain missing. It does not predict yield, profit or safety, and is not a substitute for local agronomic advice or official emergency services.'],
  ['How do sessions and cookies work?', 'The public demo uses a callsign, not a verified account. An essential HttpOnly, SameSite cookie records an expiring anonymous demo session. Browser storage retains console preferences and drafts on this device. No advertising or analytics cookies are added by the session controls. Sign out to end the session; clear site data to erase saved local drafts. Public demo records are not a private workspace.'],
  ['How are private accounts different?', 'Email-and-password accounts require email verification. Passwords are stored as salted scrypt hashes; essential secure HttpOnly cookies carry an eight-hour signed session. Account-owned farms, observations, analyses and jobs have server-side ownership checks. Private provider calls bypass shared caches and request logs. Private watchlists support evaluation, backtesting, scheduling and owner-only live digests; shared email and webhook destinations never receive private alerts. Private workspace drafts are not persisted to browser storage. Google sign-in requires configured credentials and an approved callback. Public-demo records remain shared, and the demo callsign is not authentication.'],
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">TerraField Atlas / Mission reference</p>
      <h1 className="mt-4 text-3xl font-semibold sm:text-5xl">Earth intelligence, with evidence and limits.</h1>
      <p className="mt-6 leading-relaxed text-muted-foreground">A server-rendered reference for people, search engines and answer engines. The interactive console hydrates in your browser for maps, live updates and 3D interaction.</p>
      <Link href="/" className="my-8 inline-flex min-h-11 items-center rounded border px-5">Open the mission console →</Link>
      <nav aria-label="Module references" className="border-t py-7">
        <h2 className="text-xl font-semibold">Console module guides</h2>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">{MODULE_GUIDES.map((guide) => <li key={guide.key}><Link href={`/guide/${guide.key}`} className="inline-flex min-h-11 items-center underline underline-offset-4">{guide.title}</Link></li>)}</ul>
      </nav>
      {answers.map(([question, answer]) => (
        <section key={question} className="border-t py-7">
          <h2 className="text-xl font-semibold">{question}</h2>
          <p className="mt-3 leading-relaxed text-muted-foreground">{answer}</p>
        </section>
      ))}
      <section className="border-t py-7">
        <h2 className="text-xl font-semibold">Primary sources</h2>
        <ul className="mt-4 space-y-3 underline underline-offset-4">
          <li><a href="https://power.larc.nasa.gov/">NASA POWER</a></li>
          <li><a href="https://www.earthdata.nasa.gov/platforms/gibs">NASA GIBS</a></li>
          <li><a href="https://eonet.gsfc.nasa.gov/">NASA EONET</a></li>
          <li><a href="https://soilgrids.org/">ISRIC SoilGrids</a></li>
          <li><a href="/api/v1/system/sources">Live provider availability (JSON)</a></li>
        </ul>
      </section>
    </main>
  );
}