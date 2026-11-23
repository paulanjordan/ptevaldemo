import type { GoalDraft, GoalDraftInput, GoalPattern } from '../../core/discipline.js';
import type { Finding, Measurement, MeasureValue, Side } from '../../core/types.js';

/**
 * PT goal patterns (FR-GOAL-1/2/4). Every goal is measurable, time-bound and
 * linked to its baseline record(s). Targets are placeholders for clinical-lead
 * review; the PT accepts, edits or rejects each one.
 */

/** Functional targets and the default functional tie-in per joint motion. */
const FUNCTIONAL: Record<string, { target: number; outcome: string; keywords: RegExp }> = {
  'knee|flexion': { target: 120, outcome: 'reciprocal stair negotiation', keywords: /stairs?|steps?|bike|cycling|squat|kneel/i },
  'knee|extension': { target: 0, outcome: 'normalized gait pattern', keywords: /walk|hike|hiking|run|stand/i },
  'hip|flexion': { target: 110, outcome: 'donning shoes and socks independently', keywords: /shoes|socks|dress|car/i },
  'ankle|dorsiflexion': { target: 10, outcome: 'normal heel-to-toe gait', keywords: /walk|hike|run|stairs/i },
  'shoulder|flexion': { target: 160, outcome: 'reaching overhead shelves', keywords: /reach|overhead|shelf|hair|throw/i },
  'shoulder|abduction': { target: 160, outcome: 'overhead reaching', keywords: /reach|overhead|hair/i },
  'shoulder|external rotation': { target: 70, outcome: 'reaching behind head', keywords: /hair|throw|reach/i },
};

const sideAbbr = (s: Side | null) => (s === 'right' ? 'R ' : s === 'left' ? 'L ' : s === 'bilateral' ? 'B ' : '');
const round5 = (n: number) => Math.round(n / 5) * 5;

function patientGoals(findings: Finding[]): string[] {
  return findings.filter((f) => f.fieldKey === 'subjective.patient_goals').map((f) => String(f.value));
}

/** Patient goals are quoted in first person; goals are written in third person. */
export function thirdPerson(text: string): string {
  return text
    .replace(/\bI'm\b/gi, "they're")
    .replace(/\bI am\b/gi, 'they are')
    .replace(/\bmy\b/gi, 'their')
    .replace(/\bmyself\b/gi, 'themselves')
    .replace(/\bme\b/gi, 'them')
    .replace(/\bI\b/g, 'they');
}

const GERUND: Record<string, string> = {
  go: 'going', walk: 'walking', climb: 'climbing', sit: 'sitting', stand: 'standing', run: 'running', bend: 'bending',
  kneel: 'kneeling', lift: 'lifting', squat: 'squatting', get: 'getting', reach: 'reaching', sleep: 'sleeping', drive: 'driving',
};
/** "go down stairs" → "going down stairs" for use after "when". */
export function asActivity(text: string): string {
  const t = thirdPerson(text);
  const [first, ...rest] = t.split(/\s+/);
  const g = first ? GERUND[first.toLowerCase()] : undefined;
  return g ? [g, ...rest].join(' ') : t;
}

/** Prefer the patient's own words for the functional tie-in (FR-GOAL-1). */
function tieIn(key: string, goals: string[]): { text: string; fromPatient: boolean } {
  const fn = FUNCTIONAL[key];
  const pg = fn ? goals.find((g) => fn.keywords.test(g)) : undefined;
  if (pg) return { text: thirdPerson(pg), fromPatient: true };
  return { text: fn?.outcome ?? 'improved functional mobility', fromPatient: false };
}

/** Use active ROM when both are recorded for the same joint motion. */
function preferActive(ms: Measurement[]): Measurement[] {
  const byKey = new Map<string, Measurement>();
  for (const m of ms) {
    const k = `${m.joint}|${m.motion}|${m.side}`;
    const cur = byKey.get(k);
    if (!cur || (cur.mode !== 'active' && m.mode === 'active')) byKey.set(k, m);
  }
  return [...byKey.values()];
}

export const romGoals: GoalPattern = {
  id: 'pt.rom_deficit',
  draft({ measurements, findings, measureTypes, timeframes }: GoalDraftInput): GoalDraft[] {
    const goals = patientGoals(findings);
    const out: GoalDraft[] = [];
    const rom = preferActive(measurements.filter((m) => m.measureTypeId === 'pt.rom' && m.value.kind === 'number'));
    for (const m of rom) {
      const baseline = (m.value as { value: number }).value;
      const key = `${m.joint}|${m.motion}`;
      const normal = measureTypes.get('pt.rom')?.normal?.(m) ?? null;
      if (normal === null) continue;
      const gap = normal - baseline;
      if (gap < Math.max(5, Math.abs(normal) * 0.1)) continue; // within functional limits

      const ltgTarget = Math.min(normal, FUNCTIONAL[key]?.target ?? normal);
      if (ltgTarget <= baseline) continue;
      const stgTarget = Math.min(ltgTarget, round5(baseline + (ltgTarget - baseline) / 2));
      const fn = tieIn(key, goals);
      const label = `${sideAbbr(m.side)}${m.joint} ${m.motion}${m.mode === 'active' ? ' AROM' : m.mode === 'passive' ? ' PROM' : ''}`;
      const toAllow = fn.fromPatient ? `to allow patient to ${fn.text}` : `to allow ${fn.text}`;
      const mk = (term: 'short' | 'long', target: number, weeks: number): GoalDraft => ({
        term,
        text: `Increase ${label} from ${baseline}° to ${target}° in ${weeks} weeks ${toAllow}.`,
        baselineMeasurementIds: [m.id],
        baselineFindingKeys: fn.fromPatient ? ['subjective.patient_goals'] : [],
        targetValue: { kind: 'number', value: target },
        timeframeWeeks: weeks,
        functionalOutcome: fn.text,
      });
      if (stgTarget > baseline && stgTarget < ltgTarget) out.push(mk('short', stgTarget, timeframes.shortWeeks));
      out.push(mk('long', ltgTarget, timeframes.longWeeks));
    }
    return out;
  },
};

/** MMT grades as an ordinal scale: 3-, 3, 3+, 4-, 4, 4+, 5. */
const SCALE: Array<{ grade: number; modifier: '+' | '-' | null }> = [
  { grade: 0, modifier: null }, { grade: 1, modifier: null }, { grade: 2, modifier: '-' }, { grade: 2, modifier: null }, { grade: 2, modifier: '+' },
  { grade: 3, modifier: '-' }, { grade: 3, modifier: null }, { grade: 3, modifier: '+' },
  { grade: 4, modifier: '-' }, { grade: 4, modifier: null }, { grade: 4, modifier: '+' }, { grade: 5, modifier: null },
];
const idx = (v: { grade: number; modifier: '+' | '-' | null }) => SCALE.findIndex((s) => s.grade === v.grade && s.modifier === v.modifier);
export const fmtGrade = (v: { grade: number; modifier: '+' | '-' | null }) => `${v.grade}${v.modifier ?? ''}/5`;

export const strengthGoals: GoalPattern = {
  id: 'pt.strength_deficit',
  draft({ measurements, findings, timeframes }: GoalDraftInput): GoalDraft[] {
    const goals = patientGoals(findings);
    const out: GoalDraft[] = [];
    for (const m of measurements) {
      if (m.measureTypeId !== 'pt.mmt' || m.value.kind !== 'grade') continue;
      const b = idx(m.value);
      if (b < 0 || b >= SCALE.length - 1) continue;
      const ltgIdx = b >= idx({ grade: 4, modifier: '-' }) ? SCALE.length - 1 : idx({ grade: 4, modifier: null });
      const stgIdx = Math.min(ltgIdx - 1, b + 2);
      const fn = tieIn(`${m.joint}|${m.motion}`, goals);
      const label = `${sideAbbr(m.side)}${m.joint} ${m.motion} strength`;
      const toAllow = fn.fromPatient ? ` to allow patient to ${fn.text}` : '';
      const mk = (term: 'short' | 'long', i: number, weeks: number): GoalDraft => ({
        term,
        text: `Improve ${label} from ${fmtGrade(m.value as never)} to ${fmtGrade(SCALE[i]!)} in ${weeks} weeks${toAllow}.`,
        baselineMeasurementIds: [m.id],
        baselineFindingKeys: fn.fromPatient ? ['subjective.patient_goals'] : [],
        targetValue: { kind: 'grade', ...SCALE[i]! },
        timeframeWeeks: weeks,
        functionalOutcome: fn.fromPatient ? fn.text : null,
      });
      if (stgIdx > b) out.push(mk('short', stgIdx, timeframes.shortWeeks));
      out.push(mk('long', ltgIdx, timeframes.longWeeks));
    }
    return out;
  },
};

export const painGoals: GoalPattern = {
  id: 'pt.pain',
  draft({ findings, timeframes }: GoalDraftInput): GoalDraft[] {
    const worst = findings.find((f) => f.fieldKey === 'pain.worst' && typeof f.value === 'number');
    if (!worst) return [];
    const w = worst.value as number;
    if (w < 4) return [];
    const agg = findings.find((f) => f.fieldKey === 'pain.aggravating');
    const during = agg ? ` when ${asActivity(String(agg.value))}` : '';
    const stg = Math.max(2, w - 2);
    const out: GoalDraft[] = [];
    const mk = (term: 'short' | 'long', target: number, weeks: number): GoalDraft => ({
      term,
      text: `Decrease worst pain from ${w}/10 to ≤${target}/10${during} in ${weeks} weeks.`,
      baselineMeasurementIds: [],
      baselineFindingKeys: ['pain.worst', ...(agg ? ['pain.aggravating'] : [])],
      targetValue: { kind: 'number', value: target },
      timeframeWeeks: weeks,
      functionalOutcome: agg ? String(agg.value) : null,
    });
    if (stg > 2) out.push(mk('short', stg, timeframes.shortWeeks));
    out.push(mk('long', 2, timeframes.longWeeks));
    return out;
  },
};

export const tugGoals: GoalPattern = {
  id: 'pt.tug',
  draft({ measurements, measureTypes, timeframes }: GoalDraftInput): GoalDraft[] {
    const m = measurements.find((x) => x.measureTypeId === 'pt.tug' && x.value.kind === 'number');
    if (!m) return [];
    const t = (m.value as { value: number }).value;
    const cutoff = measureTypes.get('pt.tug')?.normal?.(m) ?? 13.5;
    if (t <= cutoff) return [];
    const target: MeasureValue = { kind: 'number', value: Math.floor(cutoff) };
    return [{
      term: 'long',
      text: `Decrease Timed Up and Go from ${t} s to <${Math.floor(cutoff)} s in ${timeframes.longWeeks} weeks to reduce fall risk.`,
      baselineMeasurementIds: [m.id],
      baselineFindingKeys: [],
      targetValue: target,
      timeframeWeeks: timeframes.longWeeks,
      functionalOutcome: 'reduced fall risk',
    }];
  },
};

export const PT_GOAL_PATTERNS: GoalPattern[] = [romGoals, strengthGoals, painGoals, tugGoals];
