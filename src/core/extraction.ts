import type { CandidateMeta, DisciplineLayer, FindingCandidate, MeasurementCandidate } from './discipline.js';
import { newId } from './ids.js';
import type { EmrContext, Finding, Measurement, MeasureType, MeasureValue, ReviewFlag, Transcript } from './types.js';

export interface ExtractionConfig {
  /** Items below this confidence go to the confirm queue (FR-EXT-3). */
  confidenceThreshold: number;
}
export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = { confidenceThreshold: 0.8 };

/**
 * Runs every extractor the layer provides, then applies the core's
 * discipline-agnostic rules: dedupe, conflict detection, range validation and
 * confidence flagging. Extractors never write to the store directly.
 */
export async function runExtraction(
  sessionId: string,
  transcript: Transcript,
  ctx: EmrContext,
  layer: DisciplineLayer,
  cfg: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
): Promise<{ findings: Finding[]; measurements: Measurement[] }> {
  const fc: FindingCandidate[] = [];
  const mc: MeasurementCandidate[] = [];
  for (const ex of layer.extractors) {
    const r = await ex.extract(transcript, ctx);
    fc.push(...r.findings);
    mc.push(...r.measurements);
  }
  const mts = new Map(layer.measureTypes.map((m) => [m.id, m]));
  return {
    findings: buildFindings(sessionId, fc, layer, cfg),
    measurements: buildMeasurements(sessionId, mc, mts, cfg),
  };
}

function baseFlags(confidence: number | null, meta: CandidateMeta, cfg: ExtractionConfig): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (confidence !== null && confidence < cfg.confidenceThreshold)
    flags.push({ kind: 'low_confidence', detail: `confidence ${confidence.toFixed(2)}${meta.confidenceNote ? `: ${meta.confidenceNote}` : ''}` });
  if (meta.assumed) flags.push({ kind: 'assumed_from_context', detail: meta.assumed });
  return flags;
}

function buildFindings(
  sessionId: string,
  cands: FindingCandidate[],
  layer: DisciplineLayer,
  cfg: ExtractionConfig,
): Finding[] {
  const kinds = new Map(layer.fields.map((f) => [f.key, f.valueKind]));
  const out: Finding[] = [];
  const byKey = new Map<string, Finding[]>();

  for (const c of cands) {
    if (!kinds.has(c.fieldKey)) continue; // never write fields the schema does not define
    if (c.value === null || c.value === undefined || c.value === '') continue; // FR-EXT-5
    const f: Finding = {
      id: newId(),
      sessionId,
      fieldKey: c.fieldKey,
      value: c.value,
      confidence: c.confidence,
      sourceSpan: c.sourceSpan,
      origin: 'ai',
      status: 'pending',
      flags: baseFlags(c.confidence, c, cfg),
    };
    const list = byKey.get(c.fieldKey) ?? [];
    // List-valued fields keep each item separately (each has its own source span).
    const dup = list.find((x) => JSON.stringify(x.value) === JSON.stringify(f.value));
    if (dup) continue;
    list.push(f);
    byKey.set(c.fieldKey, list);
    out.push(f);
  }

  for (const [key, list] of byKey) {
    if (kinds.get(key) === 'text[]' || list.length < 2) continue;
    for (const f of list) f.flags.push({ kind: 'conflict', withIds: list.filter((x) => x !== f).map((x) => x.id) });
  }
  return out;
}

export function measurementIdentity(m: Pick<Measurement, 'measureTypeId' | 'joint' | 'side' | 'motion' | 'mode'>): string {
  return [m.measureTypeId, m.joint ?? '', m.side ?? '', m.motion ?? '', m.mode ?? ''].join('|');
}

export function valuesEqual(a: MeasureValue, b: MeasureValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function numericValue(v: MeasureValue): number | null {
  if (v.kind === 'number') return v.value;
  if (v.kind === 'grade') return v.grade + (v.modifier === '+' ? 0.33 : v.modifier === '-' ? -0.33 : 0);
  return null;
}

export function rangeFlag(m: Measurement, mt: MeasureType | undefined): ReviewFlag | null {
  const n = m.value.kind === 'number' ? m.value.value : m.value.kind === 'grade' ? m.value.grade : null;
  if (n === null || !mt?.plausibleRange) return null;
  const r = mt.plausibleRange(m);
  if (!r || (n >= r.min && n <= r.max)) return null;
  return { kind: 'out_of_range', detail: `${n}${m.unit ?? ''} outside plausible ${r.min}–${r.max}` };
}

function buildMeasurements(
  sessionId: string,
  cands: MeasurementCandidate[],
  mts: Map<string, MeasureType>,
  cfg: ExtractionConfig,
): Measurement[] {
  const out: Measurement[] = [];
  const byIdentity = new Map<string, Measurement[]>();

  for (const c of cands) {
    const { assumed, confidenceNote, ...rest } = c;
    const m: Measurement = {
      ...rest,
      id: newId(),
      sessionId,
      origin: 'ai',
      status: 'pending',
      flags: baseFlags(c.confidence, { assumed, confidenceNote }, cfg),
    };
    const rf = rangeFlag(m, mts.get(m.measureTypeId));
    if (rf) m.flags.push(rf);

    const k = measurementIdentity(m);
    const list = byIdentity.get(k) ?? [];
    const same = list.find((x) => valuesEqual(x.value, m.value));
    if (same) {
      // Repeated statement of the same value: keep the more confident one.
      if ((m.confidence ?? 0) > (same.confidence ?? 0)) Object.assign(same, { confidence: m.confidence, sourceSpan: m.sourceSpan });
      continue;
    }
    list.push(m);
    byIdentity.set(k, list);
    out.push(m);
  }

  for (const list of byIdentity.values()) {
    if (list.length < 2) continue;
    for (const m of list) m.flags.push({ kind: 'conflict', withIds: list.filter((x) => x !== m).map((x) => x.id) });
  }
  return out;
}

export function needsConfirmation(item: { flags: ReviewFlag[]; status: string }): boolean {
  return item.status === 'pending' && item.flags.length > 0;
}
