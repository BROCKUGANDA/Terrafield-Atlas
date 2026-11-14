'use client';

/**
 * Client-side document exports for the mission console.
 *
 * Exports are generated from data ALREADY retrieved and displayed — nothing is
 * re-fetched or synthesized. Every export includes the source datasets and
 * retrieval metadata available on the payload, so a printed or shared file
 * remains as traceable as the console itself.
 */

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  // Quote when the cell could break CSV structure: quotes, commas, newlines.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build RFC-4180-ish CSV text from headers + row tuples. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n');
}

/** Trigger a local file download via a temporary object URL. */
function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to hand off before releasing the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
  if (!filename.endsWith('.csv')) filename += '.csv';
  download(filename, toCsv(headers, rows), 'text/csv');
}

export function downloadJson(filename: string, data: unknown): void {
  if (!filename.endsWith('.json')) filename += '.json';
  download(filename, JSON.stringify(data, null, 2), 'application/json');
}

/** File-safe timestamp slug, e.g. "2026-11-14T09-30-25Z". */
export function timestampSlug(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

export function exportNote(): string {
  return 'Exported from TerraField Atlas — values are real observations traceable to their NASA/ISRIC source and retrieval time; no data fabricated.';
}
