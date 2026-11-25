import PDFDocument from 'pdfkit';

type JsonRecord = Record<string, unknown>;

export interface PdfReportInput {
  generatedAt: string;
  farm: {
    name: string;
    location: { lat: number; lon: number };
    country: string | null;
    region: string | null;
    areaHa: number | null;
    cropHistory: unknown[];
    notes: string | null;
  };
  environmentalRecord: {
    available: boolean;
    observationCount: number;
    period: { start: string | null; end: string | null };
    datasetVersions: string[];
    sources: string;
    climatology: { rainfallMonthlyMedianMm: number[]; years: number } | null;
    thermal: { meanMonthlyTemperatureC: number[]; years: number } | null;
  };
  trendAnalyses: {
    variable: string; label: string; unit: string; direction: string; significant: boolean;
    slopePerYear: number | null; ci: (number | null)[]; pValue: number | null; fdrAdjustedP: number | null;
    sampleCount: number; method: string; minSampleSatisfied: boolean; interpretation: string;
  }[];
  soilInformation: { measured: JsonRecord | null; supplementaryModeled: JsonRecord | null; note: string };
  rotationScenarios: {
    name: string; cropKeys: string[]; ruleVersion: string; overallScore: number; confidence: number;
    incompatible: unknown[]; createdAt: string;
  }[];
  provenance: JsonRecord[];
  methodology: { trendEngine: string; rotationEngine: string; honestyRules: string[] };
  limitations: string[];
}

const INK = '#131C28';
const MUTED = '#5A6674';
const RED = '#A8230F';
const LINE = '#C8CFD8';

function section(doc: PDFKit.PDFDocument, number: string, title: string): void {
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(RED).text(`${number}  ${title.toUpperCase()}`);
  doc.moveDown(0.25);
  doc.strokeColor(LINE).lineWidth(0.5).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.4);
  doc.fillColor(INK).font('Helvetica').fontSize(9);
}

function paragraph(doc: PDFKit.PDFDocument, value: string): void {
  doc.fontSize(9).fillColor(INK).text(value, { lineGap: 4 });
  doc.moveDown(0.25);
}

function bullet(doc: PDFKit.PDFDocument, value: string): void {
  doc.fontSize(8.5).fillColor(MUTED).text(`•  ${value}`, { lineGap: 3 });
}

export async function createReportPdf(report: PdfReportInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 52, bufferPages: true, info: {
    Title: `TerraField Atlas assessment — ${report.farm.name}`,
    Author: 'TerraField Atlas',
    Subject: 'Evidence-grounded farm assessment',
    CreationDate: new Date(report.generatedAt),
  } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('TERRAFIELD ATLAS');
  doc.font('Helvetica').fontSize(9).fillColor(RED).text('FARM ASSESSMENT · EVIDENCE DOCUMENT');
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(report.farm.name);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${report.farm.region ?? ''}${report.farm.region && report.farm.country ? ', ' : ''}${report.farm.country ?? ''}`);
  doc.text(`${report.farm.location.lat.toFixed(4)}°, ${report.farm.location.lon.toFixed(4)}° · generated ${new Date(report.generatedAt).toUTCString()}`);
  doc.moveDown(0.6);

  section(doc, '00', 'Executive summary');
  const significant = report.trendAnalyses.filter((item) => item.significant);
  paragraph(doc, `This assessment compiles ${report.environmentalRecord.observationCount.toLocaleString()} stored environmental observations, ${report.trendAnalyses.length} trend results, ${report.rotationScenarios.length} rotation scenarios, and ${report.provenance.length} provenance records for ${report.farm.name}.`);
  paragraph(doc, significant.length
    ? `${significant.length} variable${significant.length === 1 ? '' : 's'} reached statistical significance after seasonal adjustment and multiple-testing control: ${significant.map((item) => `${item.label} (${item.direction})`).join('; ')}.`
    : 'No variable reached the configured significance threshold; absence of significance is not evidence of absence of change.');
  paragraph(doc, 'Recommendations remain under human decision authority. No yield, harvest, or profit prediction is made.');

  section(doc, '01', 'Geographic scope and observation coverage');
  paragraph(doc, `Period: ${report.environmentalRecord.period.start ?? '—'} to ${report.environmentalRecord.period.end ?? '—'}. Source: ${report.environmentalRecord.sources}.`);
  paragraph(doc, `Dataset versions: ${report.environmentalRecord.datasetVersions.join(', ') || 'not recorded'}.`);
  if (report.farm.areaHa !== null) paragraph(doc, `Boundary area: ${report.farm.areaHa.toFixed(2)} hectares.`);
  if (report.farm.cropHistory.length) paragraph(doc, `Farmer-supplied crop history: ${report.farm.cropHistory.length} season record(s).`);
  if (report.farm.notes) paragraph(doc, `Notes: ${report.farm.notes}`);

  section(doc, '02', 'Environmental findings');
  if (report.trendAnalyses.length === 0) {
    paragraph(doc, 'No trend analyses are stored for this farm.');
  } else {
    for (const item of report.trendAnalyses) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`${item.label} — ${item.direction}${item.significant ? ' (significant)' : ''}`);
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
        `${item.label} slope ${item.slopePerYear ?? 'n/a'} ${item.unit}/yr · 95% CI ${item.ci[0] ?? 'n/a'} … ${item.ci[1] ?? 'n/a'} · p ${item.pValue ?? 'n/a'} · FDR p ${item.fdrAdjustedP ?? 'n/a'} · n ${item.sampleCount} monthly observations`,
      );
      paragraph(doc, item.interpretation);
    }
  }

  section(doc, '03', 'Soil and agronomic context');
  paragraph(doc, report.soilInformation.measured ? `Measured soil record from ${String(report.soilInformation.measured.source ?? 'unknown source')}.` : 'No measured soil test is stored.');
  paragraph(doc, report.soilInformation.supplementaryModeled ? `Supplementary modeled SoilGrids profile present. ${report.soilInformation.note}` : report.soilInformation.note);
  for (const scenario of report.rotationScenarios) {
    paragraph(doc, `${scenario.name}: score ${scenario.overallScore.toFixed(3)}, confidence ${scenario.confidence.toFixed(3)}, ${scenario.cropKeys.join(' → ')}, ${scenario.incompatible.length} incompatibility flag(s), rule ${scenario.ruleVersion}.`);
  }

  section(doc, '04', 'Statistical methodology');
  paragraph(doc, report.methodology.trendEngine);
  paragraph(doc, report.methodology.rotationEngine);

  section(doc, '05', 'Uncertainty, limitations, and evidence');
  for (const rule of report.methodology.honestyRules) bullet(doc, rule);
  for (const limitation of report.limitations) bullet(doc, limitation);
  doc.moveDown(0.4);
  paragraph(doc, `Provenance records retained with this report: ${report.provenance.length}. Each analytical result is versioned and traceable in the console evidence ledger.`);

  const range = doc.bufferedPageRange();
  for (let page = 0; page < range.count; page++) {
    doc.switchToPage(range.start + page);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
      `TerraField Atlas · evidence document · no yield or profit guarantee · page ${page + 1} of ${range.count}`,
      52,
      doc.page.height - 34,
      { width: doc.page.width - 104, align: 'center' },
    );
  }
  doc.end();
  return done;
}
