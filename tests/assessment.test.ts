import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, MVP_FLAGS } from '../src/app.js';
import { DisciplineRegistry } from '../src/core/discipline.js';
import { StaticFlags } from '../src/core/flags.js';
import { validateNarrative } from '../src/core/narrative.js';
import { ScriptedTranscriber, type LlmClient } from '../src/core/providers.js';
import { EvalAssistant } from '../src/core/session.js';
import { createMemoryStore } from '../src/core/store.js';
import { ASSESSMENT_SYSTEM_PROMPT, assessmentPayload, LlmAssessmentDrafter } from '../src/disciplines/pt/assessment.js';
import { withAiAssessment } from '../src/disciplines/pt/index.js';
import { MockEmr } from '../src/emr/mock.js';
import { KNEE_EVAL_TRANSCRIPT } from '../src/fixtures.js';

const PT = 'pt-1';

async function visit(a: EvalAssistant) {
  const s = await a.openFromAppointment('appt-1', PT);
  await a.captureConsent(s.id, 'verbal', PT);
  const r = a.createRecorder(s.id, { upload: async () => {} });
  r.start();
  await r.stop();
  await a.finishRecording(s.id, r, new ScriptedTranscriber(KNEE_EVAL_TRANSCRIPT));
  await a.extract(s.id);
  a.draftGoals(s.id);
  return s.id;
}

function withLayer(client: LlmClient) {
  const registry = new DisciplineRegistry();
  registry.register(withAiAssessment(client));
  const emr = MockEmr.withTestPatient();
  return { emr, a: new EvalAssistant({ store: createMemoryStore(), registry, emr, flags: new StaticFlags(new Set(MVP_FLAGS)), clock: () => new Date('2026-11-23T16:00:00Z') }) };
}

describe('rule-based assessment (default until an AI vendor is approved)', () => {
  let a: EvalAssistant;
  let emr: MockEmr;
  beforeEach(() => {
    emr = MockEmr.withTestPatient();
    a = createApp({ emr, clock: () => new Date('2026-11-23T16:00:00Z') }).assistant;
  });

  it('covers presentation, impairments, function, impression and plan from the whole visit', async () => {
    const id = await visit(a);
    const [f] = await a.draftNarratives(id);
    expect(f!.fieldKey).toBe('assessment.summary');
    expect(f!.parts!.map((p) => p.key)).toEqual(['summary', 'impairments', 'function', 'impression', 'plan']);
    const text = String(f!.value);
    expect(text).toContain('55 y/o female referred by Dr. Example Ortho');
    expect(text).toContain('decreased R knee flexion AROM (95°, L 135°)');
    expect(text).toContain('decreased R knee extension strength (4-/5)');
    expect(text).toContain('pain when going down stairs');
    expect(text).toContain('Prior to onset, patient was able to hike 5 miles on weekends');
    expect(text).toContain('positive McMurray (R); negative Lachman and anterior drawer (R)');
    expect(text).toContain('climb the stairs at school without holding the rail');
    expect(text).toContain('2x/week for 8 weeks');
    expect(text).not.toMatch(/\bmy\b|\bI\b/); // patient quotes turned into third person
  });

  it('cites real items for every paragraph and passes its own number check', async () => {
    const id = await visit(a);
    const [f] = await a.draftNarratives(id);
    expect(f!.parts!.every((p) => p.evidence.length > 0)).toBe(true);
    expect(f!.flags.map((x) => x.kind)).toEqual(['requires_review']);
    expect(f!.flags[0]!.kind === 'requires_review' && f!.flags[0]!.detail).toContain('Clinical impression');
  });

  it('goes to the confirm queue and blocks signing until the PT confirms or edits it', async () => {
    const id = await visit(a);
    const [f] = await a.draftNarratives(id);
    expect(a.confirmQueue(id).some((q) => q.ref.id === f!.id)).toBe(true);
    expect(a.completeness(id).map((m) => m.key)).not.toContain('assessment.summary');
    for (const q of a.confirmQueue(id)) if (q.ref.id !== f!.id) a.confirm(q.ref, PT);
    for (const g of a.goals(id)) a.confirm({ kind: 'goal', id: g.id }, PT);
    await expect(a.sign(id, PT, { acknowledgeIncomplete: true })).rejects.toThrow(/1 item\(s\) in the confirm queue/);
    a.edit({ kind: 'finding', id: f!.id }, PT, { value: `${f!.value}\n\nGood rehab potential.` });
    await a.sign(id, PT, { acknowledgeIncomplete: true });
    expect(emr.signedNotes[0]!.fields['assessment.summary']).toContain('Good rehab potential.');
    expect(emr.signedNotes[0]!.narrative).toContain('[AI, edited]');
  });

  it('leaves out items the PT rejected', async () => {
    const id = await visit(a);
    const mcm = a.measurements(id).find((m) => m.motion === 'McMurray')!;
    a.reject({ kind: 'measurement', id: mcm.id }, PT);
    const [f] = await a.draftNarratives(id);
    expect(String(f!.value)).not.toContain('McMurray');
  });

  it('never overwrites an assessment the PT wrote, and redrafts an untouched AI draft', async () => {
    const id = await visit(a);
    const [first] = await a.draftNarratives(id);
    const [second] = await a.draftNarratives(id);
    expect(second!.id).not.toBe(first!.id);
    expect(a.findings(id).filter((f) => f.fieldKey === 'assessment.summary')).toHaveLength(1);

    a.edit({ kind: 'finding', id: second!.id }, PT, { value: 'My own assessment.' });
    expect(await a.draftNarratives(id)).toEqual([]);
    expect(a.findings(id).find((f) => f.fieldKey === 'assessment.summary')!.value).toBe('My own assessment.');
  });

  it('is gated by its own feature flag', async () => {
    const off = createApp({ flags: new StaticFlags(new Set(MVP_FLAGS.filter((f) => f !== 'eval_assistant.narratives'))) }).assistant;
    const id = await visit(off);
    await expect(off.draftNarratives(id)).rejects.toThrow(/eval_assistant.narratives/);
  });
});

describe('AI assessment drafter', () => {
  it('sends the whole visit with short refs and no name or date of birth', async () => {
    let sent = { system: '', user: '' };
    const { a } = withLayer({ async completeJson(system, user) { sent = { system, user }; return { parts: [] }; } });
    const id = await visit(a);
    await a.draftNarratives(id);
    expect(sent.system).toBe(ASSESSMENT_SYSTEM_PROMPT);
    const payload = JSON.parse(sent.user);
    expect(payload.patient).toEqual({ age: 55, sex: 'F' });
    expect(payload.transcript).toHaveLength(KNEE_EVAL_TRANSCRIPT.length);
    expect(payload.measurements[0].ref).toBe('M1');
    expect(payload.goals.length).toBeGreaterThan(0);
    expect(sent.user).not.toContain('Test Patient');
    expect(sent.user).not.toContain('1971-04-02');
  });

  it('maps refs back to items and keeps judgment flags', async () => {
    const { a } = withLayer({
      async completeJson(_s, user) {
        const p = JSON.parse(user);
        const flex = p.measurements.find((m: { item: string }) => m.item === 'R knee flexion AROM 95°');
        return { parts: [
          { key: 'impairments', text: 'R knee flexion AROM limited to 95°.', evidence: [flex.ref], needsJudgment: false },
          { key: 'impression', text: 'Findings consistent with R knee OA; good rehab potential.', evidence: ['T2'], needsJudgment: false },
        ] };
      },
    });
    const id = await visit(a);
    const [f] = await a.draftNarratives(id);
    const flex = a.measurements(id).find((m) => m.motion === 'flexion' && m.side === 'right' && m.mode === 'active')!;
    expect(f!.parts![0]!.evidence).toEqual([{ kind: 'measurement', id: flex.id }]);
    expect(f!.parts![1]).toMatchObject({ heading: 'Clinical impression', needsJudgment: true, evidence: [{ kind: 'transcript', segmentIndex: 1 }] });
    expect(f!.flags.map((x) => x.kind)).toEqual(['requires_review']);
  });

  it('flags invented numbers and citations that do not exist', async () => {
    const { a } = withLayer({
      async completeJson(_s, user) {
        const p = JSON.parse(user);
        const flex = p.measurements.find((m: { item: string }) => m.item === 'R knee flexion AROM 95°');
        return { parts: [
          { key: 'impairments', text: 'R knee flexion AROM 95°, improving to 110° with warm-up.', evidence: [flex.ref], needsJudgment: false },
          { key: 'plan', text: 'Skilled PT indicated.', evidence: ['M999'], needsJudgment: false },
        ] };
      },
    });
    const id = await visit(a);
    const [f] = await a.draftNarratives(id);
    const unsupported = f!.flags.filter((x) => x.kind === 'unsupported_claim').map((x) => (x as { detail: string }).detail);
    expect(unsupported).toHaveLength(2);
    expect(unsupported[0]).toMatch(/states 110/);
    expect(unsupported[1]).toMatch(/not in this visit/);
    expect(a.confirmQueue(id)[0]!.ref.id).toBe(f!.id); // unsupported claims sort to the top
  });

  it('rejects malformed model output instead of charting it', async () => {
    const { a } = withLayer({ async completeJson() { return { text: 'free prose' }; } });
    const id = await visit(a);
    await expect(a.draftNarratives(id)).rejects.toThrow(/no "parts" array/);
    expect(a.findings(id).some((f) => f.fieldKey === 'assessment.summary')).toBe(false);
  });
});

describe('validateNarrative', () => {
  it('accepts numbers from context (age) and treats ICD codes as text', async () => {
    const { a } = withLayer({ async completeJson() { return { parts: [] }; } });
    const id = await visit(a);
    const v = a.visitSnapshot(id);
    const pain = v.findings.find((f) => f.fieldKey === 'pain.worst')!;
    expect(validateNarrative([{ key: 'summary', heading: 'Presentation', text: '55 y/o with M17.11; pain 8/10 at worst.', evidence: [{ kind: 'finding', id: pain.id }], needsJudgment: false }], v)).toEqual([]);
    expect(assessmentPayload(v).refs.get('T1')).toEqual({ kind: 'transcript', segmentIndex: 0 });
  });
});
