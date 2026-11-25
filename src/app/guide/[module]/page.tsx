import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MODULE_GUIDES } from '@/lib/module-guides';

export const dynamicParams = false;
export function generateStaticParams() {
  return MODULE_GUIDES.map((guide) => ({ module: guide.key }));
}
type Props = { params: Promise<{ module: string }> };
async function guideFor({ params }: Props) {
  const { module } = await params;
  const guide = MODULE_GUIDES.find((entry) => entry.key === module);
  if (!guide) notFound();
  return guide;
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const guide = await guideFor(props);
  return { title: guide.title, description: guide.description, alternates: { canonical: `/guide/${guide.key}` } };
}
export default async function ModuleGuide(props: Props) {
  const guide = await guideFor(props);
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">TerraField Atlas / Module reference</p>
      <h1 className="mt-4 text-3xl font-semibold sm:text-5xl">{guide.title}</h1>
      <p className="mt-6 leading-relaxed text-muted-foreground">{guide.description}</p>
      <Link href={`/#view=${guide.key}`} className="my-8 inline-flex min-h-11 items-center rounded border px-5">Open {guide.title} →</Link>
      <section className="border-t py-7"><h2 className="text-xl font-semibold">How to use this module</h2><p className="mt-3 leading-relaxed text-muted-foreground">{guide.usage}</p></section>
      <section className="border-t py-7"><h2 className="text-xl font-semibold">Evidence and limitations</h2><p className="mt-3 leading-relaxed text-muted-foreground">{guide.limit}</p></section>
      <nav aria-label="Module references" className="border-t py-7">
        <h2 className="text-xl font-semibold">Explore the console</h2>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">{MODULE_GUIDES.map((entry) => <li key={entry.key}><Link className="inline-flex min-h-11 items-center underline underline-offset-4" href={`/guide/${entry.key}`} aria-current={entry.key === guide.key ? 'page' : undefined}>{entry.title}</Link></li>)}</ul>
        <Link href="/about" className="mt-4 inline-flex min-h-11 items-center underline underline-offset-4">Data, methodology and privacy</Link>
      </nav>
    </main>
  );
}