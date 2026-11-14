'use client';

import { ClipboardList, Copy, ScrollText, Trash2, CheckCheck, Bell } from 'lucide-react';
import { useMissionLog, eventTime, type LogSeverity, type MissionEvent } from '@/components/state/log-store';
import { useUiStore } from '@/components/state/ui-store';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

/**
 * Mission Log — the console's auditable event ledger.
 * Header button with unread badge; right-side sheet lists every logged action
 * with UTC timestamp, severity, category, and correlation ID where present.
 */

const SEVERITY_DOT: Record<LogSeverity, string> = {
  info: 'bg-aqua',
  success: 'bg-signal',
  warn: 'bg-caution',
  crit: 'bg-crit',
};

const SEVERITY_TEXT: Record<LogSeverity, string> = {
  info: 'text-aqua',
  success: 'text-signal',
  warn: 'text-caution',
  crit: 'text-crit',
};

export function MissionLogButton() {
  const { events, unread, markAllRead, clear } = useMissionLog();
  const sheetOpen = useUiStore((s) => s.logOpen);
  const setSheetOpen = useUiStore((s) => s.setLogOpen);
  const { toast } = useToast();
  const hasUnread = unread > 0;

  const copyCorrelation = (id: string) => {
    void navigator.clipboard
      .writeText(id)
      .then(() => toast({ title: 'Correlation ID copied', description: `${id} copied to clipboard.` }))
      .catch(() => toast({ title: 'Copy failed', description: 'Clipboard unavailable in this browser.', variant: 'destructive' }));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={`Mission log — ${events.length} events logged, ${unread} unread`}
        className={cn(
          'relative flex h-8 items-center gap-1.5 rounded-sm border border-edge bg-panel px-2.5 transition-colors hover:border-aqua/50 hover:text-aqua focus-visible:outline-2 focus-visible:outline-offset-2',
          hasUnread ? 'text-dim' : 'text-faint',
        )}
        style={{ outlineColor: 'var(--aqua)' }}
        title="Mission log — local audit ledger of console actions"
      >
        <Bell className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden font-mono text-[10px] uppercase tracking-wide-mc sm:inline">log</span>
        {hasUnread && (
          <span
            className="telemetry absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-nasa px-1 text-[9px] font-semibold text-white"
            aria-hidden
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (open) markAllRead();
          setSheetOpen(open);
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 border-edge bg-sidebar p-0 sm:w-[420px]"
          aria-label="Mission log"
        >
          <SheetHeader className="border-b border-edge px-4 py-3">
            <SheetTitle className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide-mc text-ink">
              <ScrollText className="h-4 w-4 text-nasa" aria-hidden />
              Mission Log
            </SheetTitle>
            <SheetDescription className="font-mono text-[10px] leading-relaxed tracking-wide text-faint">
              Local browser ledger of console actions — UTC timestamps. Not transmitted anywhere.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {events.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <ClipboardList className="h-8 w-8 text-faint/60" aria-hidden />
                <p className="text-sm text-dim">No console actions logged yet.</p>
                <p className="text-xs text-faint">
                  Ingestions, analyses, rotation comparisons, reports, exports and provider warnings
                  will appear here as you operate the console.
                </p>
              </div>
            ) : (
              <ol className="flex flex-col divide-y divide-edge/60" aria-label="Logged mission events">
                {(events as MissionEvent[]).map((ev) => (
                  <li key={ev.id} className="anim-fade-up px-4 py-3 transition-colors hover:bg-panel-2/40">
                    <div className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[ev.severity])} aria-hidden />
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-mission text-faint">
                        {ev.category}
                      </span>
                      <span className="telemetry ml-auto text-[10px] text-faint">{eventTime(ev.ts)}</span>
                    </div>
                    <p className={cn('mt-1 text-[13px] font-medium', SEVERITY_TEXT[ev.severity])}>{ev.title}</p>
                    {ev.detail && <p className="mt-0.5 text-xs leading-relaxed text-dim">{ev.detail}</p>}
                    {ev.correlationId && (
                      <button
                        type="button"
                        onClick={() => copyCorrelation(ev.correlationId as string)}
                        className="telemetry mt-1.5 inline-flex items-center gap-1 rounded-sm border border-edge bg-panel px-1.5 py-0.5 text-[10px] text-dim transition-colors hover:border-aqua/50 hover:text-aqua"
                        title="Copy correlation ID"
                        aria-label={`Copy correlation ID ${ev.correlationId}`}
                      >
                        <Copy className="h-3 w-3" aria-hidden />
                        {ev.correlationId}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-edge px-4 py-3">
            <p className="telemetry flex-1 text-[10px] text-faint">
              {events.length} event{events.length === 1 ? '' : 's'} retained (max 200)
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllRead}
              disabled={unread === 0}
              className="h-7 gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wide-mc text-dim hover:text-aqua"
            >
              <CheckCheck className="h-3 w-3" aria-hidden />
              Mark read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={events.length === 0}
              className="h-7 gap-1.5 px-2 font-mono text-[10px] uppercase tracking-wide-mc text-dim hover:text-crit"
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              Clear
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
