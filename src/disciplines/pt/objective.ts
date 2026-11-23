import type { MeasurementCandidate } from '../../core/discipline.js';
import type { EmrContext, MeasureMode, Side, SourceSpan, TranscriptSegment } from '../../core/types.js';
import { clauses, findAll, sentences, type Hit, type Piece } from './text.js';

/**
 * Deterministic parser for spoken PT measurements (FR-OBJ-1/2).
 *
 * This is the precise half of extraction: numbers, sides and grades are where
 * generic LLM scribes fail, and a rule parser gives exact source spans. The
 * LLM extractor (when a vendor is approved) handles narrative fields.
 *
 * Never invents: anything not stated stays null (FR-EXT-5). The only context
 * fallback is laterality from the referral, which is always flagged.
 */

const SIDES: Array<[RegExp, Side]> = [
  [/\bbilateral(?:ly)?\b|\bboth sides\b|\bboth (?:knees|hips|ankles|shoulders)\b/i, 'bilateral'],
  [/\bright\b/i, 'right'],
  [/\bleft\b/i, 'left'],
];
/** Case-sensitive single-letter sides ("R knee"). */
const SIDE_LETTERS: Array<[RegExp, Side]> = [
  [/\bR\b/, 'right'],
  [/\bL\b/, 'left'],
];

const JOINTS: Array<[RegExp, string]> = [
  [/\bknees?\b/i, 'knee'],
  [/\bhips?\b/i, 'hip'],
  [/\bankles?\b/i, 'ankle'],
  [/\bshoulders?\b/i, 'shoulder'],
  [/\belbows?\b/i, 'elbow'],
  [/\bwrists?\b/i, 'wrist'],
  [/\blumbar\b|\blow back\b|\btrunk\b/i, 'lumbar'],
  [/\bcervical\b|\bneck\b/i, 'cervical'],
];

const MOTIONS: Array<[RegExp, string]> = [
  [/\binternal rotation\b|\bIR\b/i, 'internal rotation'],
  [/\bexternal rotation\b|\bER\b/i, 'external rotation'],
  [/\blateral flexion\b|\bside ?bend(?:ing)?\b/i, 'lateral flexion'],
  [/\bdorsi ?flexion\b/i, 'dorsiflexion'],
  [/\bplantar ?flexion\b/i, 'plantarflexion'],
  [/\bflexion\b|\bflexes\b|\bflex\b/i, 'flexion'],
  [/\bextension\b|\bextends\b/i, 'extension'],
  [/\babduction\b/i, 'abduction'],
  [/\badduction\b/i, 'adduction'],
  [/\binversion\b/i, 'inversion'],
  [/\beversion\b/i, 'eversion'],
  [/\brotation\b/i, 'rotation'],
];

/** Muscle names imply joint + motion for MMT. */
const MUSCLES: Array<[RegExp, { joint: string; motion: string }]> = [
  [/\bquads?\b|\bquadriceps\b|\bknee extensors\b/i, { joint: 'knee', motion: 'extension' }],
  [/\bhamstrings?\b|\bknee flexors\b/i, { joint: 'knee', motion: 'flexion' }],
  [/\bglute(?:us)? med(?:ius)?\b|\bhip abductors\b/i, { joint: 'hip', motion: 'abduction' }],
  [/\bglute(?:us)? max(?:imus)?\b|\bhip extensors\b/i, { joint: 'hip', motion: 'extension' }],
  [/\bhip flexors\b|\biliopsoas\b/i, { joint: 'hip', motion: 'flexion' }],
  [/\bdorsiflexors\b|\btib(?:ialis)? anterior\b/i, { joint: 'ankle', motion: 'dorsiflexion' }],
  [/\bplantarflexors\b|\bcalf\b|\bgastroc(?:nemius)?\b/i, { joint: 'ankle', motion: 'plantarflexion' }],
  [/\bdeltoid\b/i, { joint: 'shoulder', motion: 'abduction' }],
  [/\bbiceps\b/i, { joint: 'elbow', motion: 'flexion' }],
  [/\btriceps\b/i, { joint: 'elbow', motion: 'extension' }],
];

const MODES: Array<[RegExp, MeasureMode]> = [
  [/\bactive(?:ly)?\b|\bAROM\b/i, 'active'],
  [/\bpassive(?:ly)?\b|\bPROM\b/i, 'passive'],
];

type TestDef = { name: string; joint: string };
const SPECIAL_TESTS: Array<[RegExp, TestDef]> = [
  [/\blachman'?s?\b/i, { name: 'Lachman', joint: 'knee' }],
  [/\banterior drawer\b/i, { name: 'Anterior drawer', joint: 'knee' }],
  [/\bposterior drawer\b/i, { name: 'Posterior drawer', joint: 'knee' }],
  [/\bmc ?murray'?s?\b/i, { name: 'McMurray', joint: 'knee' }],
  [/\bthessaly\b/i, { name: 'Thessaly', joint: 'knee' }],
  [/\bvalgus stress\b/i, { name: 'Valgus stress', joint: 'knee' }],
  [/\bvarus stress\b/i, { name: 'Varus stress', joint: 'knee' }],
  [/\bpatellar grind\b|\bclarke'?s\b/i, { name: 'Patellar grind', joint: 'knee' }],
  [/\bober'?s?\b/i, { name: 'Ober', joint: 'hip' }],
  [/\bthomas test\b/i, { name: 'Thomas', joint: 'hip' }],
  [/\bfaber\b|\bpatrick'?s\b/i, { name: 'FABER', joint: 'hip' }],
  [/\bfadir\b/i, { name: 'FADIR', joint: 'hip' }],
  [/\bstraight leg raise\b|\bSLR\b/i, { name: 'Straight leg raise', joint: 'lumbar' }],
  [/\bslump\b/i, { name: 'Slump', joint: 'lumbar' }],
  [/\bprone instability\b/i, { name: 'Prone instability', joint: 'lumbar' }],
  [/\bneer'?s?\b/i, { name: 'Neer', joint: 'shoulder' }],
  [/\bhawkins(?:[- ]kennedy)?\b/i, { name: 'Hawkins-Kennedy', joint: 'shoulder' }],
  [/\bempty can\b/i, { name: 'Empty can', joint: 'shoulder' }],
  [/\bspurling'?s?\b/i, { name: 'Spurling', joint: 'cervical' }],
];
const RESULTS: Array<[RegExp, 'positive' | 'negative' | 'equivocal']> = [
  [/\bpositive\b|\bpos\b/i, 'positive'],
  [/\bnegative\b|\bneg\b/i, 'negative'],
  [/\bequivocal\b|\binconclusive\b/i, 'equivocal'],
];

const IMPLIED_JOINT: Record<string, string> = { dorsiflexion: 'ankle', plantarflexion: 'ankle', inversion: 'ankle', eversion: 'ankle' };
const REGION: Record<string, string> = {
  knee: 'lower_extremity', hip: 'lower_extremity', ankle: 'lower_extremity',
  shoulder: 'upper_extremity', elbow: 'upper_extremity', wrist: 'upper_extremity',
  lumbar: 'spine', cervical: 'spine',
};
const AXIAL = new Set(['lumbar', 'cervical']);

const NOT_DEGREES = /^\s*(?:weeks?|days?|months?|years?|yrs?|times|x\b|reps?|sets?|seconds?|secs?|minutes?|mins?|%|percent|out of 10|\/\s*10|cm\b|centimet|inch|pounds?|lbs?)/i;
const NEG_BEFORE = /(?:lacking|lacks|lacks about|minus|negative|short of|shy of)\s*$/i;
const MMT_CUE = /out of (?:5|five)\b|\/\s*5\b|\bstrength\b|\bMMT\b|manual muscle/i;

interface Ctx<T> { v: T; sentence: number }
interface SegmentCtx {
  side?: Ctx<Side>;
  joint?: Ctx<string>;
  motion?: Ctx<string>;
}

export function parseObjective(segments: TranscriptSegment[], ctx: EmrContext): MeasurementCandidate[] {
  const out: MeasurementCandidate[] = [];
  segments.forEach((seg, segIdx) => {
    if (seg.speaker !== 'clinician') return;
    const state: SegmentCtx = {};
    sentences(seg.text).forEach((sent, sIdx) => {
      out.push(...parseSpecialTests(sent, segIdx, state, ctx));
      const sentIsMmt = MMT_CUE.test(sent.text) || findAll(sent.text, MUSCLES).length > 0;
      for (const cl of clauses(sent)) {
        if (findAll(cl.text, SPECIAL_TESTS).length) continue;
        if (/out of (?:10|ten)\b|\/\s*10\b/i.test(cl.text)) continue; // pain scale, handled by subjective parser
        const span = (p: Piece): SourceSpan => ({ segmentIndex: segIdx, start: p.start, end: p.end, text: p.text });
        const sides = [...findAll(cl.text, SIDES), ...findAll(cl.text, SIDE_LETTERS)];
        const joints = findAll(cl.text, JOINTS);
        const muscles = findAll(cl.text, MUSCLES);
        const motions = findAll(cl.text, MOTIONS);

        // A muscle name sets joint+motion for this clause.
        if (muscles[0]) {
          state.joint = { v: muscles[0].value.joint, sentence: sIdx };
          state.motion = { v: muscles[0].value.motion, sentence: sIdx };
        }
        if (joints.length) state.joint = { v: joints[joints.length - 1]!.value, sentence: sIdx };
        if (motions.length) state.motion = { v: motions[motions.length - 1]!.value, sentence: sIdx };
        if (sides.length) state.side = { v: sides[sides.length - 1]!.value, sentence: sIdx };
        if (!joints.length && state.motion && IMPLIED_JOINT[state.motion.v] && state.motion.sentence === sIdx)
          state.joint = { v: IMPLIED_JOINT[state.motion.v]!, sentence: sIdx };

        const isMmt = MMT_CUE.test(cl.text) || muscles.length > 0 || (sentIsMmt && allSmall(cl.text));
        const values = isMmt ? grades(cl.text) : degrees(cl.text);
        if (!values.length) continue;
        if (!state.joint || !state.motion) continue; // cannot place it: leave for LLM / manual entry

        const modes = isMmt ? [] : assignModes(cl.text, values);
        values.forEach((val, i) => {
          let confidence = 0.95;
          const reasons: string[] = [];
          const joint = state.joint!.v;
          if (state.joint!.sentence !== sIdx) { confidence -= 0.1; reasons.push('joint from earlier sentence'); }
          if (state.motion!.sentence !== sIdx) { confidence -= 0.1; reasons.push('motion from earlier sentence'); }

          let side: Side | null = state.side?.v ?? null;
          let assumed: string | undefined;
          if (state.side && state.side.sentence !== sIdx) { confidence -= 0.1; reasons.push('side from earlier sentence'); }
          if (!side && !AXIAL.has(joint)) {
            if (ctx.referral?.side) {
              side = ctx.referral.side;
              assumed = `side not stated; taken from referral (${side})`;
            } else {
              confidence -= 0.4;
              reasons.push('side not stated');
            }
          }
          const mode = modes[i] ?? null;
          if (!isMmt && !mode) { confidence -= 0.2; reasons.push('active/passive not stated'); }

          out.push({
            measureTypeId: isMmt ? 'pt.mmt' : 'pt.rom',
            bodyRegion: REGION[joint] ?? null,
            joint,
            side: AXIAL.has(joint) ? null : side,
            motion: state.motion!.v,
            mode,
            value: val.value,
            unit: isMmt ? null : 'deg',
            notes: null,
            confidenceNote: reasons.length ? reasons.join('; ') : undefined,
            confidence: round(confidence),
            sourceSpan: span(cl),
            assumed,
          });
        });
      }
    });
  });
  return out;
}

type Parsed = Hit<MeasurementCandidate['value']>;

function degrees(text: string): Parsed[] {
  const out: Parsed[] = [];
  const re = /(-)?\b(\d{1,3}(?:\.\d+)?)\b(?:\s*(?:degrees?|°))?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const after = text.slice(m.index + m[0].length);
    if (NOT_DEGREES.test(after)) continue;
    const before = text.slice(0, m.index);
    if (/(?:out of|\/)\s*$/i.test(before)) continue; // denominator of "6 out of 10"
    const neg = Boolean(m[1]) || NEG_BEFORE.test(before);
    const n = Number(m[2]);
    out.push({ value: { kind: 'number', value: neg ? -n : n }, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function grades(text: string): Parsed[] {
  const out: Parsed[] = [];
  const re = /\b([0-5])(?:\s*(\+|-|plus|minus)(?!\s*\d))?(?:\s*(?:out of|\/)\s*(?:5|five)\b)?/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const mod = m[2] ? (m[2] === '+' || m[2].toLowerCase() === 'plus' ? '+' : '-') : null;
    out.push({ value: { kind: 'grade', grade: Number(m[1]), modifier: mod }, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function allSmall(text: string): boolean {
  const nums = text.match(/\b\d+(?:\.\d+)?\b/g);
  return Boolean(nums?.length) && nums!.every((n) => Number(n) <= 5);
}

/**
 * Pair active/passive words with values: a mode right after a value belongs to
 * it ("95 active"); otherwise it applies to the next value ("PROM 105").
 */
function assignModes(text: string, values: Parsed[]): Array<MeasureMode | null> {
  const modes = findAll(text, MODES);
  const res: Array<MeasureMode | null> = values.map(() => null);
  for (const md of modes) {
    const prevIdx = values.findLastIndex((v) => v.end <= md.start);
    const between = prevIdx >= 0 ? text.slice(values[prevIdx]!.end, md.start) : null;
    if (prevIdx >= 0 && res[prevIdx] === null && between !== null && /^[\s°a-z]*$/i.test(between) && !/\d/.test(between) && between.trim().split(/\s+/).filter(Boolean).length <= 2) {
      res[prevIdx] = md.value;
      continue;
    }
    const nextIdx = values.findIndex((v) => v.start >= md.end);
    if (nextIdx >= 0 && res[nextIdx] === null) res[nextIdx] = md.value;
  }
  // "AROM right knee flexion 95" with a single value and a single mode
  if (modes.length === 1 && values.length === 1 && res[0] === null) res[0] = modes[0]!.value;
  return res;
}

function parseSpecialTests(sent: Piece, segIdx: number, state: SegmentCtx, ctx: EmrContext): MeasurementCandidate[] {
  const tests = findAll(sent.text, SPECIAL_TESTS);
  if (!tests.length) return [];
  const results = findAll(sent.text, RESULTS);
  const sides = [...findAll(sent.text, SIDES), ...findAll(sent.text, SIDE_LETTERS)];
  const events = [...tests.map((t) => ({ t, kind: 'test' as const })), ...results.map((r) => ({ r, kind: 'result' as const }))].sort(
    (a, b) => (a.kind === 'test' ? a.t.start : a.r.start) - (b.kind === 'test' ? b.t.start : b.r.start),
  );
  const out: MeasurementCandidate[] = [];
  let pendingTests: Hit<TestDef>[] = [];
  let pendingResult: Hit<'positive' | 'negative' | 'equivocal'> | null = null;
  const emit = (t: Hit<TestDef>, r: Hit<'positive' | 'negative' | 'equivocal'>) => {
    const from = Math.min(t.start, r.start);
    const to = Math.max(t.end, r.end);
    const nearestSide = sides.length ? sides.reduce((a, b) => (Math.abs(b.start - t.start) < Math.abs(a.start - t.start) ? b : a)) : null;
    let side: Side | null = nearestSide?.value ?? (state.side?.v ?? null);
    let assumed: string | undefined;
    let confidence = nearestSide ? 0.95 : state.side ? 0.85 : 0.95;
    if (!side && !AXIAL.has(t.value.joint)) {
      if (ctx.referral?.side) { side = ctx.referral.side; assumed = `side not stated; taken from referral (${side})`; }
      else confidence = 0.55;
    }
    out.push({
      measureTypeId: 'pt.special_test',
      bodyRegion: REGION[t.value.joint] ?? null,
      joint: t.value.joint,
      side: AXIAL.has(t.value.joint) && t.value.name !== 'Straight leg raise' && t.value.name !== 'Slump' ? null : side,
      motion: t.value.name,
      mode: null,
      value: { kind: 'result', result: r.value },
      unit: null,
      notes: null,
      confidence,
      sourceSpan: { segmentIndex: segIdx, start: sent.start + from, end: sent.start + to, text: sent.text.slice(from, to) },
      assumed,
    });
  };
  for (const e of events) {
    if (e.kind === 'test') {
      if (pendingResult) { emit(e.t, pendingResult); pendingResult = null; }
      else pendingTests.push(e.t);
    } else if (pendingTests.length) {
      for (const t of pendingTests) emit(t, e.r);
      pendingTests = [];
    } else pendingResult = e.r;
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
