import type { EmrContext, Finding, Goal, Measurement, ReviewFlag, Transcript } from './types.js';

/**
 * Narrative sections (e.g. the PT assessment) are drafted from the whole
 * visit rather than extracted from one sentence. Each paragraph carries the
 * evidence it was written from, so the PT can check it and so the core can
 * catch claims the visit does not support.
 */

export type EvidenceRef =
  | { kind: 'finding' | 'measurement' | 'goal'; id: string }
  | { kind: 'transcript'; segmentIndex: number };

export interface NarrativePart {
  key: string; // e.g. "summary", "impairments"
  heading: string;
  text: string;
  evidence: EvidenceRef[];
  /** Clinical judgment (impression, prognosis): always needs the PT's eye. */
  needsJudgment: boolean;
}

/** Everything known about the visit, minus rejected and unresolved items. */
export interface VisitSnapshot {
  context: EmrContext;
  ageYears: number | null;
  transcript: Transcript;
  findings: Finding[];
  measurements: Measurement[];
  goals: Goal[];
  /** Display text per item id, from the discipline's formatter. */
  display: Map<string, string>;
}

export interface NarrativeDrafter {
  readonly name: string;
  /** The clinical field key the narrative fills (e.g. "assessment.summary"). */
  readonly fieldKey: string;
  draft(visit: VisitSnapshot): Promise<NarrativePart[]>;
}

export const joinParts = (parts: NarrativePart[]): string => parts.map((p) => p.text.trim()).filter(Boolean).join('\n\n');

/** Numbers like 95, 4.5, -5; ignores digits inside words such as "M17". */
const NUM = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w])/g;

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUM)) {
    const n = Number(m[0]);
    out.add(String(n));
    out.add(String(Math.abs(n)));
  }
  return out;
}

/**
 * Guardrail for model-written narratives:
 * - every evidence reference must point at an item that exists in the visit;
 * - every number in a paragraph must appear in that paragraph's evidence
 *   (or the EMR context). A number with no source is treated as invented.
 */
export function validateNarrative(parts: NarrativePart[], visit: VisitSnapshot): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const items = new Map<string, unknown>([
    ...visit.findings.map((f) => [f.id, f] as const),
    ...visit.measurements.map((m) => [m.id, m] as const),
    ...visit.goals.map((g) => [g.id, g] as const),
  ]);
  const contextText = JSON.stringify({
    age: visit.ageYears,
    referral: visit.context.referral,
    precautions: visit.context.precautions,
    surgicalHistory: visit.context.surgicalHistory,
  });

  for (const p of parts) {
    const badRefs: string[] = [];
    let sourceText = contextText;
    for (const e of p.evidence) {
      if (e.kind === 'transcript') {
        const seg = visit.transcript.segments[e.segmentIndex];
        if (!seg) badRefs.push(`transcript segment ${e.segmentIndex}`);
        else sourceText += ' ' + seg.text;
      } else {
        const item = items.get(e.id);
        if (!item) badRefs.push(`${e.kind} ${e.id}`);
        else sourceText += ' ' + JSON.stringify(item) + ' ' + (visit.display.get(e.id) ?? '');
      }
    }
    if (badRefs.length) flags.push({ kind: 'unsupported_claim', detail: `"${p.heading}" cites items that are not in this visit: ${badRefs.join(', ')}` });
    if (!p.evidence.length) flags.push({ kind: 'unsupported_claim', detail: `"${p.heading}" cites no evidence` });

    const allowed = numbersIn(sourceText);
    const missing = [...numbersIn(p.text)].filter((n) => !allowed.has(n));
    // numbersIn adds both n and |n|; report each value once
    const unique = [...new Set(missing.map((n) => String(Math.abs(Number(n)))))];
    if (unique.length) flags.push({ kind: 'unsupported_claim', detail: `"${p.heading}" states ${unique.join(', ')}, which does not appear in its evidence` });
  }
  return flags;
}
