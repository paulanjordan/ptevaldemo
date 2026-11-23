import type { EvidenceRef, NarrativeDrafter, NarrativePart, VisitSnapshot } from '../../core/narrative.js';
import type { LlmClient } from '../../core/providers.js';
import type { Finding, Measurement, Side } from '../../core/types.js';
import { asActivity, fmtGrade, thirdPerson } from './goals.js';
import { PT_MEASURE_TYPES } from './measureTypes.js';

/**
 * The PT assessment: a short narrative written from the whole visit that
 * states who the patient is and why they are here, the impairments found,
 * the functional limitations they cause, the clinical impression, and why
 * skilled PT is needed to reach the patient's goals.
 */

export const ASSESSMENT_FIELD = 'assessment.summary';

const HEADINGS: Record<string, string> = {
  summary: 'Presentation',
  impairments: 'Impairments',
  function: 'Functional limitations',
  impression: 'Clinical impression',
  plan: 'Goals and need for skilled PT',
};
const JUDGMENT_KEYS = new Set(['impression']);

// ---------------------------------------------------------------------------
// AI drafter
// ---------------------------------------------------------------------------

export const ASSESSMENT_SYSTEM_PROMPT = `You write the Assessment section of a physical therapy initial evaluation note. A licensed PT will read, edit and sign what you write, and it becomes part of the legal medical record, so accuracy matters more than polish.

Write in the style of an experienced outpatient PT: third person ("Patient is a..."), concise clinical prose, standard abbreviations where PTs use them (y/o, R/L, AROM/PROM, MMT, PLOF, HEP). Aim for 120 to 220 words in total.

Return JSON with a "parts" array, in this order, one entry per part you can support from the visit:
- "summary": age, sex, referral diagnosis and referring provider if known, chief complaint, onset or mechanism, and current pain.
- "impairments": the problem areas found on exam, with the measured values (ROM, strength, pain, effusion, gait, special tests). Compare with the uninvolved side when it was measured.
- "function": the functional limitations those impairments cause, contrasted with prior level of function, and relevant work or home demands.
- "impression": whether the findings are consistent with the referral diagnosis, and anything the findings suggest that the referring provider should know. Stay within PT scope: use "consistent with" or "suggestive of", never a new medical diagnosis. Include rehab potential only if the PT stated it or the findings clearly support it.
- "plan": the patient's own goals in plain words, why skilled PT is needed to reach them, and the planned frequency and interventions if stated.

Each part is {"key", "text", "evidence", "needsJudgment"}.
- "evidence" lists the references of every item the text relies on, using the ref values in the visit data (for example "M3", "F2", "G1", "T7"). The PT uses these to check your work.
- Every number in your text must come from the evidence you cite. Do not estimate, round into new values, or fill gaps; if something was not measured or said, leave it out.
- Set "needsJudgment" to true for statements of clinical judgment (impression, prognosis, rehab potential) so the PT confirms them.

Items with status "pending" are not yet confirmed by the PT but are the best available data; items the PT rejected have already been removed.`;

interface LlmPart {
  key: string;
  text: string;
  evidence: string[];
  needsJudgment: boolean;
}

/** Builds the visit payload with short refs (F1, M1, G1, T1) instead of ids. */
export function assessmentPayload(v: VisitSnapshot): { payload: object; refs: Map<string, EvidenceRef> } {
  const refs = new Map<string, EvidenceRef>();
  const add = (prefix: string, i: number, ref: EvidenceRef) => {
    const key = `${prefix}${i + 1}`;
    refs.set(key, ref);
    return key;
  };
  const payload = {
    // Minimum necessary: no name, DOB or identifiers.
    patient: { age: v.ageYears, sex: v.context.patient.sex ?? null },
    referral: v.context.referral ? { diagnosis: `${v.context.referral.diagnosisText} (${v.context.referral.diagnosisCode})`, referringProvider: v.context.referral.referringProvider } : null,
    precautions: v.context.precautions,
    surgicalHistory: v.context.surgicalHistory,
    findings: v.findings.map((f, i) => ({ ref: add('F', i, { kind: 'finding', id: f.id }), item: v.display.get(f.id), status: f.status })),
    measurements: v.measurements.map((m, i) => ({ ref: add('M', i, { kind: 'measurement', id: m.id }), item: v.display.get(m.id), status: m.status })),
    goals: v.goals.map((g, i) => ({ ref: add('G', i, { kind: 'goal', id: g.id }), term: g.term, text: g.text, status: g.status })),
    transcript: v.transcript.segments.map((s, i) => ({ ref: add('T', i, { kind: 'transcript', segmentIndex: i }), speaker: s.speaker, text: s.text })),
  };
  return { payload, refs };
}

export class LlmAssessmentDrafter implements NarrativeDrafter {
  readonly name = 'pt.assessment.llm';
  readonly fieldKey = ASSESSMENT_FIELD;
  constructor(private client: LlmClient) {}

  async draft(v: VisitSnapshot): Promise<NarrativePart[]> {
    const { payload, refs } = assessmentPayload(v);
    const raw = await this.client.completeJson(ASSESSMENT_SYSTEM_PROMPT, JSON.stringify(payload));
    const parts = parseLlmParts(raw);
    return parts.map((p) => ({
      key: p.key,
      heading: HEADINGS[p.key] ?? p.key,
      text: p.text.trim(),
      // Unknown refs are kept visible as transcript index -1 so validation flags them.
      evidence: p.evidence.map((r) => refs.get(r) ?? ({ kind: 'transcript', segmentIndex: -1 } as const)),
      needsJudgment: p.needsJudgment || JUDGMENT_KEYS.has(p.key),
    }));
  }
}

function parseLlmParts(raw: unknown): LlmPart[] {
  const parts = (raw as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) throw new Error('assessment model output has no "parts" array');
  return parts.map((p, i) => {
    const x = p as Partial<LlmPart>;
    if (typeof x.key !== 'string' || typeof x.text !== 'string' || !Array.isArray(x.evidence))
      throw new Error(`assessment part ${i} is malformed`);
    return { key: x.key, text: x.text, evidence: x.evidence.map(String), needsJudgment: Boolean(x.needsJudgment) };
  });
}

// ---------------------------------------------------------------------------
// Rule-based drafter (used until an AI vendor is approved under a BAA)
// ---------------------------------------------------------------------------

const S: Record<Side, string> = { right: 'R', left: 'L', bilateral: 'B' };
const sideOf = (s: Side | null) => (s ? `${S[s]} ` : '');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const EPONYM = /^(Lachman|McMurray|Thessaly|Ober|Thomas|FABER|FADIR|Neer|Hawkins|Spurling)/;
const romType = PT_MEASURE_TYPES.find((m) => m.id === 'pt.rom')!;

export class RuleAssessmentDrafter implements NarrativeDrafter {
  readonly name = 'pt.assessment.rules';
  readonly fieldKey = ASSESSMENT_FIELD;

  async draft(v: VisitSnapshot): Promise<NarrativePart[]> {
    const parts: NarrativePart[] = [];
    const ev = (...items: Array<Finding | Measurement | { id: string; term: string }>): EvidenceRef[] =>
      items.map((i) => ('fieldKey' in i ? { kind: 'finding', id: i.id } : 'measureTypeId' in i ? { kind: 'measurement', id: i.id } : { kind: 'goal', id: i.id }));
    const one = (key: string) => v.findings.find((f) => f.fieldKey === key);
    const many = (key: string) => v.findings.filter((f) => f.fieldKey === key);
    const sentence = (s: string) => cap(s.trim().replace(/[.\s]+$/, '')) + '.';

    // ---- summary ----
    {
      const used: Finding[] = [];
      const bits: string[] = [];
      const r = v.context.referral;
      const who = [v.ageYears !== null ? `${v.ageYears} y/o` : null, v.context.patient.sex === 'F' ? 'female' : v.context.patient.sex === 'M' ? 'male' : null].filter(Boolean).join(' ');
      bits.push(`Patient is ${who ? `a ${who}` : 'seen'}${r ? ` referred by ${r.referringProvider} with ${r.diagnosisText.toLowerCase()} (${r.diagnosisCode})` : ''}.`);
      const cc = one('subjective.chief_complaint');
      if (cc) { used.push(cc); bits.push(`Chief complaint: ${String(cc.value).replace(/\.$/, '')}.`); }
      const mech = one('subjective.mechanism');
      if (mech) { used.push(mech); bits.push(`Onset per patient report: ${thirdPerson(String(mech.value)).replace(/^It /, 'it ')}.`); }
      const loc = one('pain.location');
      const pains = (['current', 'best', 'worst'] as const).map((q) => [q, one(`pain.${q}`)] as const).filter(([, f]) => f);
      if (loc || pains.length) {
        if (loc) used.push(loc);
        pains.forEach(([, f]) => used.push(f!));
        const rated = pains.map(([q, f]) => `${f!.value}/10 ${q === 'current' ? 'now' : `at ${q}`}`);
        bits.push(sentence(`Reports pain${loc ? ` at ${thirdPerson(String(loc.value))}` : ''}${rated.length ? `, rated ${list(rated)}` : ''}`));
      }
      if (used.length) parts.push({ key: 'summary', heading: HEADINGS.summary!, text: bits.join(' '), evidence: ev(...used), needsJudgment: false });
    }

    // ---- impairments ----
    const categories: string[] = [];
    {
      const used: Array<Finding | Measurement> = [];
      const items: string[] = [];
      const rom = preferActive(v.measurements.filter((m) => m.measureTypeId === 'pt.rom' && m.value.kind === 'number'));
      for (const m of rom) {
        const val = (m.value as { value: number }).value;
        const normal = romType.normal?.(m) ?? null;
        if (normal === null || normal - val < Math.max(5, Math.abs(normal) * 0.1)) continue;
        const mode = m.mode === 'active' ? ' AROM' : m.mode === 'passive' ? ' PROM' : '';
        const other = v.measurements.find((o) => o.measureTypeId === 'pt.rom' && o.joint === m.joint && o.motion === m.motion && o.mode === m.mode && o.side && m.side && o.side !== m.side && o.side !== 'bilateral' && o.value.kind === 'number');
        const cmp = other ? `, ${S[other.side!]} ${(other.value as { value: number }).value}°` : '';
        items.push(normal === 0 && val < 0 ? `${sideOf(m.side)}${m.joint} ${m.motion}${mode} lacking ${-val}°` : `decreased ${sideOf(m.side)}${m.joint} ${m.motion}${mode} (${val}°${cmp})`);
        used.push(m, ...(other ? [other] : []));
      }
      if (items.length) categories.push('range of motion');
      const weak = v.measurements.filter((m) => m.measureTypeId === 'pt.mmt' && m.value.kind === 'grade' && !(m.value.grade === 5 && !m.value.modifier));
      for (const m of weak) { items.push(`decreased ${sideOf(m.side)}${m.joint} ${m.motion} strength (${fmtGrade(m.value as never)})`); used.push(m); }
      if (weak.length) categories.push('strength');
      const worst = one('pain.worst');
      if (worst && typeof worst.value === 'number' && worst.value >= 4) { items.push(`pain up to ${worst.value}/10`); used.push(worst); categories.push('pain'); }
      for (const f of many('objective.observation')) {
        const m = String(f.value).match(/\b((?:mild|moderate|severe|trace)\s+)?(effusion|swelling|edema)\b/i);
        if (m) { items.push(m[0].toLowerCase()); used.push(f); categories.push('swelling'); }
      }
      for (const f of many('objective.gait')) {
        if (/antalgic/i.test(String(f.value))) { items.push('antalgic gait'); used.push(f); categories.push('gait'); }
      }
      if (items.length) parts.push({ key: 'impairments', heading: HEADINGS.impairments!, text: `Examination shows ${list(items)}.`, evidence: ev(...used), needsJudgment: false });
    }

    // ---- function ----
    {
      const used: Finding[] = [];
      const bits: string[] = [];
      const agg = many('pain.aggravating');
      if (agg.length) { used.push(...agg); bits.push(`Functional limitations include pain when ${list(agg.map((f) => asActivity(String(f.value))))}.`); }
      const plof = many('subjective.plof');
      if (plof.length) { used.push(...plof); bits.push(`Prior to onset, patient was able to ${list(plof.map((f) => thirdPerson(String(f.value))))}.`); }
      const job = one('subjective.occupation');
      if (job) { used.push(job); bits.push(`Patient works as ${/^[aeiou]/i.test(String(job.value)) ? 'an' : 'a'} ${job.value}.`); }
      if (used.length) parts.push({ key: 'function', heading: HEADINGS.function!, text: bits.join(' '), evidence: ev(...used), needsJudgment: false });
    }

    // ---- impression (clinical judgment: always flagged) ----
    {
      const tests = v.measurements.filter((m) => m.measureTypeId === 'pt.special_test' && m.value.kind === 'result');
      // "negative Lachman and anterior drawer (R)": group by side, eponyms keep capitals
      const name = (t: Measurement) => (EPONYM.test(t.motion ?? '') ? t.motion! : (t.motion ?? '').toLowerCase());
      const by = (r: string) => {
        const hits = tests.filter((t) => (t.value as { result: string }).result === r);
        const sides = [...new Set(hits.map((t) => t.side))];
        return sides.map((sd) => `${list(hits.filter((t) => t.side === sd).map(name))}${sd ? ` (${S[sd]})` : ''}`);
      };
      const bits: string[] = [];
      const pos = by('positive');
      const neg = by('negative');
      if (pos.length || neg.length) bits.push(sentence(`Special tests: ${[pos.length ? `positive ${list(pos)}` : '', neg.length ? `negative ${list(neg)}` : ''].filter(Boolean).join('; ')}`));
      if (v.context.referral && (tests.length || categories.length)) bits.push(`Findings are consistent with the referral diagnosis of ${v.context.referral.diagnosisText.toLowerCase()}.`);
      const evidence = ev(...tests);
      if (bits.length && evidence.length === 0) evidence.push(...ev(...v.measurements.slice(0, 1)));
      if (bits.length && evidence.length) parts.push({ key: 'impression', heading: HEADINGS.impression!, text: bits.join(' '), evidence, needsJudgment: true });
    }

    // ---- goals and need for skilled PT ----
    {
      const used: Array<Finding | { id: string; term: string }> = [];
      const bits: string[] = [];
      const goals = many('subjective.patient_goals');
      if (goals.length) { used.push(...goals); bits.push(`Patient's goals are to ${list(goals.map((f) => thirdPerson(String(f.value))))}.`); }
      if (categories.length) bits.push(`Patient would benefit from skilled physical therapy to address impaired ${list([...new Set(categories)])} and restore function${goals.length ? ' toward these goals' : ''}.`);
      const freq = one('plan.frequency');
      const tx = many('plan.interventions');
      if (freq || tx.length) {
        if (freq) used.push(freq);
        used.push(...tx);
        bits.push(sentence(`Plan: ${[freq ? String(freq.value) : '', tx.length ? `${list(tx.map((f) => String(f.value).toLowerCase()))}` : ''].filter(Boolean).join(', including ')}`));
      }
      const g = v.goals.filter((x) => x.status !== 'rejected');
      if (g.length) { used.push(...g); bits.push(`See ${g.filter((x) => x.term === 'short').length} short-term and ${g.filter((x) => x.term === 'long').length} long-term goals below.`); }
      if (used.length) parts.push({ key: 'plan', heading: HEADINGS.plan!, text: bits.join(' '), evidence: ev(...used), needsJudgment: false });
    }
    return parts;
  }
}

function preferActive(ms: Measurement[]): Measurement[] {
  const byKey = new Map<string, Measurement>();
  for (const m of ms) {
    const k = `${m.joint}|${m.motion}|${m.side}`;
    const cur = byKey.get(k);
    if (!cur || (cur.mode !== 'active' && m.mode === 'active')) byKey.set(k, m);
  }
  return [...byKey.values()];
}
