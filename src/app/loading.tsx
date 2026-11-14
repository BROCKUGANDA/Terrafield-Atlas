import { SkeletonPanel } from '@/components/system/skeletons';

/**
 * SSR loading state for the console route. Shown while the server component
 * tree streams — themed as the rest of the HUD, never a blank white frame.
 */
export default function ConsoleLoading() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 py-6" role="status" aria-live="polite" aria-label="Console loading">
      <SkeletonPanel label="Establishing console link" rows={4} />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonPanel label="Earth telemetry" rows={3} />
        <SkeletonPanel label="Field modules" rows={3} />
      </div>
    </div>
  );
}
