type Labels = Record<string, string>;

interface Sample { labels: Labels; value: number }
interface HistogramSample { labels: Labels; count: number; sum: number }

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelKey = (labels: Labels) => Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join('|');
const formatLabels = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length === 0 ? '' : `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(',')}}`;
};

export class MetricStore {
  private counters = new Map<string, Map<string, Sample>>();
  private gauges = new Map<string, Map<string, Sample>>();
  private histograms = new Map<string, Map<string, HistogramSample>>();

  increment(name: string, labels: Labels = {}, value = 1): void {
    const key = labelKey(labels);
    const series = this.counters.get(name) ?? new Map<string, Sample>();
    const current = series.get(key) ?? { labels, value: 0 };
    current.value += value;
    series.set(key, current);
    this.counters.set(name, series);
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    const series = this.gauges.get(name) ?? new Map<string, Sample>();
    series.set(labelKey(labels), { labels, value });
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const series = this.histograms.get(name) ?? new Map<string, HistogramSample>();
    const current = series.get(key) ?? { labels, count: 0, sum: 0 };
    current.count += 1;
    current.sum += value;
    series.set(key, current);
    this.histograms.set(name, series);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const sample of series.values()) lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
    }
    for (const [name, series] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const sample of series.values()) lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
    }
    for (const [name, series] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const sample of series.values()) {
        lines.push(`${name}_count${formatLabels(sample.labels)} ${sample.count}`);
        lines.push(`${name}_sum${formatLabels(sample.labels)} ${sample.sum}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

export const appMetrics = new MetricStore();

export function normalizeMetricPath(pathname: string): string {
  return pathname
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g, ':id')
    .replace(/\/[cm][0-9a-zA-Z]{20,}/g, '/:id');
}
