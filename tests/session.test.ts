import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, MVP_FLAGS } from '../src/app.js';
import { StaticFlags } from '../src/core/flags.js';
import { ScriptedTranscriber } from '../src/core/providers.js';
import { SignBlockedError, type EvalAssistant } from '../src/core/session.js';
import type { Store } from '../src/core/store.js';
import type { TranscriptSegment } from '../src/core/types.js';
import { MockEmr } from '../src/emr/mock.js';
import { KNEE_EVAL_TRANSCRIPT } from '../src/fixtures.js';
import { clin } from './helpers.js';

const PT = 'pt-1';
let emr: MockEmr;
let a: EvalAssistant;
let store: Store;

beforeEach(() => {
  emr = MockEmr.withTestPatient();
  ({ assistant: a, store } = createApp({ emr }));
});

async function recordAndExtract(transcript: TranscriptSegment[] = KNEE_EVAL_TRANSCRIPT) {
  const s = await a.openFromAppointment('appt-1', PT);
  await a.captureConsent(s.id, 'verbal', PT);
  const r = a.createRecorder(s.id, { upload: async () => {} });
  r.start();
  r.capture(new Uint8Array(8), 60_000);
  await r.stop();
  await a.finishRecording(s.id, r, new ScriptedTranscriber(transcript));
  await a.extract(s.id);
  return s.id;
}

/** Resolve everything the way a PT would before signing. */
function resolveAll(id: string) {
  for (const q of a.confirmQueue(id)) a.confirm(q.ref, PT);
  for (const g of a.goals(id).filter((g) => g.status === 'pending')) a.confirm({ kind: 'goal', id: g.id }, PT);
}

describe('opening a session (FR-REC-1, FR-TPL-2)', () => {
  it('binds to the appointment and suggests the knee template from M17.11', async () => {
    const s = await a.openFromAppointment('appt-1', PT);
    expect(s).toMatchObject({ patientId: 'pat-test-1', encounterId: 'enc-1', clinicianId: PT, templateId: 'pt.knee', status: 'draft' });
    expect(s.context.precautions).toEqual(['No impact activities']);
  });

  it('resumes the existing draft instead of creating a second session', async () => {
    const s1 = await a.openFromAppointment('appt-1', PT);
    const s2 = await a.openFromAppointment('appt-1', PT);
    expect(s2.id).toBe(s1.id);
  });

  it('rejects a clinician not on the appointment', async () => {
    await expect(a.openFromAppointment('appt-1', 'pt-2')).rejects.toThrow(/not assigned/);
  });

  it('is gated by feature flags', async () => {
    const off = createApp({ emr, flags: new StaticFlags(new Set(MVP_FLAGS.filter((f) => f !== 'eval_assistant.discipline.pt'))) }).assistant;
    await expect(off.openFromAppointment('appt-1', PT)).rejects.toThrow(/eval_assistant.discipline.pt/);
  });
});

describe('consent (FR-REC-2)', () => {
  it('writes consent to the chart and unblocks recording', async () => {
    const s = await a.openFromAppointment('appt-1', PT);
    const r = a.createRecorder(s.id, { upload: async () => {} });
    expect(() => r.start()).toThrow(/consent/);
    await a.captureConsent(s.id, 'verbal', PT);
    r.start();
    expect(emr.consents[0]).toMatchObject({ encounterId: 'enc-1', consent: { type: 'verbal', capturedBy: PT } });
  });
});

describe('extraction into the store', () => {
  it('stores provenance and confidence on every AI item (FR-EXT-2/3)', async () => {
    const id = await recordAndExtract();
    const items = [...a.findings(id), ...a.measurements(id)];
    expect(items.length).toBeGreaterThan(20);
    for (const i of items) {
      expect(i.origin).toBe('ai');
      expect(i.sourceSpan?.text.length).toBeGreaterThan(0);
      expect(i.confidence).toBeGreaterThan(0);
    }
    expect(a.session(id).status).toBe('in_review');
  });

  it('flags conflicting values for the same measure (FR-EXT-3)', async () => {
    const id = await recordAndExtract(clin('Right knee flexion 95 active.', 'Actually right knee flexion 100 active.'));
    const q = a.confirmQueue(id);
    expect(q).toHaveLength(2);
    expect(q.every((e) => e.flags.some((f) => f.kind === 'conflict'))).toBe(true);
  });

  it('flags implausible values (FR-OBJ-4)', async () => {
    const id = await recordAndExtract(clin('Right knee flexion 195 active.'));
    expect(a.confirmQueue(id)[0]!.flags).toContainEqual(expect.objectContaining({ kind: 'out_of_range' }));
  });

  it('orders the confirm queue: conflicts, out-of-range, assumptions, low confidence (FR-REV-1)', async () => {
    const id = await recordAndExtract(clin(
      'Knee flexion 100.', // low confidence + assumed side from referral
      'Right hip flexion 300 active.', // out of range
      'Right ankle dorsiflexion 5 active.', 'Right ankle dorsiflexion 10 active.', // conflict
    ));
    const kinds = a.confirmQueue(id).map((e) => Math.min(...e.flags.map((f) => ['conflict', 'out_of_range', 'assumed_from_context', 'low_confidence'].indexOf(f.kind))));
    expect(kinds).toEqual([...kinds].sort());
    expect(kinds[0]).toBe(0);
  });
});

describe('templates (FR-TPL-2/4)', () => {
  it('reports empty required fields', async () => {
    const id = await recordAndExtract();
    expect(a.completeness(id).map((m) => m.key)).toEqual(['subjective.chief_complaint', 'assessment.summary']);
  });

  it('switching templates keeps every extracted item', async () => {
    const id = await recordAndExtract();
    const before = a.previewNote(id).sections.flatMap((s) => s.lines.map((l) => l.ref.id)).sort();
    a.setTemplate(id, 'pt.lumbar', PT);
    const after = a.previewNote(id).sections.flatMap((s) => s.lines.map((l) => l.ref.id)).sort();
    expect(after).toEqual(before);
    expect(a.previewNote(id).sections.map((s) => s.title)).toContain('Other findings'); // knee special tests have no lumbar slot
  });
});

describe('goals (FR-GOAL-1..4)', () => {
  it('links every goal to a baseline and uses patient goals as functional tie-in', async () => {
    const id = await recordAndExtract();
    const goals = a.draftGoals(id);
    expect(goals.length).toBeGreaterThan(0);
    for (const g of goals) {
      expect(g.baselineMeasurementIds.length + g.baselineFindingKeys.length).toBeGreaterThan(0);
      expect(g.timeframeWeeks).toBeGreaterThan(0);
      expect(g.targetValue).not.toBeNull();
    }
    const flex = goals.find((g) => g.term === 'long' && g.text.includes('knee flexion'))!;
    const baseline = a.measurements(id).find((m) => m.id === flex.baselineMeasurementIds[0])!;
    expect(baseline).toMatchObject({ motion: 'flexion', side: 'right', mode: 'active', value: { value: 95 } });
    expect(flex.text).toBe('Increase R knee flexion AROM from 95° to 120° in 8 weeks to allow patient to climb the stairs at school without holding the rail.');
  });

  it('does not draft goals from an unresolved conflict', async () => {
    const id = await recordAndExtract(clin('Right knee flexion 95 active.', 'Right knee flexion 100 active.'));
    expect(a.draftGoals(id)).toEqual([]);
    const [first, second] = a.confirmQueue(id);
    a.confirm(first!.ref, PT);
    a.reject(second!.ref, PT);
    expect(a.draftGoals(id).length).toBeGreaterThan(0);
  });

  it('lets the PT edit, reject and add goals', async () => {
    const id = await recordAndExtract();
    const [g1, g2] = a.draftGoals(id);
    a.edit({ kind: 'goal', id: g1!.id }, PT, { text: 'Edited goal', timeframeWeeks: 6 });
    a.reject({ kind: 'goal', id: g2!.id }, PT);
    a.addGoal(id, PT, { term: 'long', text: 'Return to hiking 5 miles', baselineMeasurementIds: [], baselineFindingKeys: ['subjective.plof'], targetValue: { kind: 'text', text: '5 miles' }, timeframeWeeks: 12, functionalOutcome: 'hiking' });
    const goals = a.goals(id);
    expect(goals.find((g) => g.id === g1!.id)).toMatchObject({ status: 'edited', text: 'Edited goal', timeframeWeeks: 6 });
    expect(goals.find((g) => g.id === g2!.id)!.status).toBe('rejected');
    expect(goals.filter((g) => g.origin === 'clinician')).toHaveLength(1);
  });
});

describe('review and sign (FR-REV-1..4)', () => {
  it('blocks signing until queue, goals and required fields are handled', async () => {
    const id = await recordAndExtract();
    a.draftGoals(id);
    const err = await a.sign(id, PT).catch((e) => e);
    expect(err).toBeInstanceOf(SignBlockedError);
    expect((err as SignBlockedError).reasons).toHaveLength(3);
    expect(emr.signedNotes).toHaveLength(0);
  });

  it('allows signing with empty required fields only when acknowledged', async () => {
    const id = await recordAndExtract();
    a.draftGoals(id);
    resolveAll(id);
    await expect(a.sign(id, PT)).rejects.toThrow(/required fields empty/);
    await a.sign(id, PT, { acknowledgeIncomplete: true });
    expect(a.session(id).status).toBe('signed');
  });

  it('writes discrete data + narrative, emits eval.signed, audits, then locks', async () => {
    const id = await recordAndExtract();
    a.addFinding(id, PT, 'subjective.chief_complaint', 'R knee pain');
    a.addFinding(id, PT, 'assessment.summary', 'R knee OA');
    a.draftGoals(id);
    resolveAll(id);
    const events: string[] = [];
    a.events.subscribe((e) => events.push(e.type));

    await a.sign(id, PT);

    const note = emr.signedNotes[0]!;
    expect(note.measurements.length).toBe(a.measurements(id).length);
    expect(note.fields['pain.worst']).toBe(8);
    expect(note.fields['subjective.patient_goals']).toHaveLength(2);
    expect(note.narrative).toContain('R knee flexion AROM 95° [AI]');
    expect(note.narrative).toContain('Chief complaint: R knee pain [PT]');
    expect(events).toEqual(['eval.signed']);
    expect(a.audit.forSession(id).some((e) => e.action === 'session.signed')).toBe(true);
    expect(a.findings(id).every((f) => f.status !== 'pending')).toBe(true);
    expect(() => a.addFinding(id, PT, 'pain.best', 1)).toThrow(/locked/);
  });

  it('stays unsigned if the EMR write fails', async () => {
    const id = await recordAndExtract();
    a.draftGoals(id);
    resolveAll(id);
    emr.failWrites = true;
    await expect(a.sign(id, PT, { acknowledgeIncomplete: true })).rejects.toThrow(/EMR write failed/);
    expect(a.session(id).status).toBe('in_review');
  });

  it('marks AI-drafted vs edited vs clinician content (FR-REV-2)', async () => {
    const id = await recordAndExtract();
    const m = a.measurements(id).find((x) => x.motion === 'flexion' && x.side === 'left')!;
    a.edit({ kind: 'measurement', id: m.id }, PT, { value: { kind: 'number', value: 138 } });
    a.addFinding(id, PT, 'assessment.summary', 'OA');
    const lines = a.previewNote(id).sections.flatMap((s) => s.lines);
    expect(lines.find((l) => l.ref.id === m.id)).toMatchObject({ provenance: 'ai_edited', text: 'L knee flexion AROM 138°' });
    expect(lines.find((l) => l.text === 'OA')!.provenance).toBe('clinician');
  });

  it('audits every AI fill and clinician edit with before/after', async () => {
    const id = await recordAndExtract();
    const m = a.measurements(id)[0]!;
    a.edit({ kind: 'measurement', id: m.id }, PT, { value: { kind: 'number', value: 90 } });
    const log = a.audit.forSession(id);
    expect(log.filter((e) => e.action === 'ai.fill')).toHaveLength(a.findings(id).length + a.measurements(id).length);
    const edit = log.find((e) => e.action === 'clinician.edit')!;
    expect(edit).toMatchObject({ actor: PT, entityId: m.id });
    expect((edit.before as { value: unknown }).value).toEqual(m.value);
    expect((edit.after as { value: unknown }).value).toEqual({ kind: 'number', value: 90 });
  });

  it('only the session clinician can edit or sign', async () => {
    const id = await recordAndExtract();
    expect(() => a.confirm({ kind: 'measurement', id: a.measurements(id)[0]!.id }, 'pt-2')).toThrow(/not the session clinician/);
    await expect(a.sign(id, 'pt-2')).rejects.toThrow();
  });
});

describe('manual entry (FR-OBJ-3)', () => {
  it('writes the same Measurement record and confirms out-of-range values explicitly', async () => {
    const id = await recordAndExtract(clin('Right knee flexion 95 active.'));
    const m = { measureTypeId: 'pt.rom', bodyRegion: 'lower_extremity', joint: 'hip', side: 'right' as const, motion: 'flexion', mode: 'active' as const, value: { kind: 'number' as const, value: 400 }, unit: 'deg', notes: null };
    expect(() => a.addMeasurement(id, PT, m)).toThrow(/out of range/);
    const saved = a.addMeasurement(id, PT, { ...m, value: { kind: 'number', value: 100 } });
    expect(saved).toMatchObject({ origin: 'clinician', status: 'confirmed' });
    expect(a.measurements(id)).toHaveLength(2);
  });
});

describe('retention and observability', () => {
  it('deletes audio on sign by default but keeps the transcript', async () => {
    const id = await recordAndExtract();
    a.draftGoals(id);
    resolveAll(id);
    await a.sign(id, PT, { acknowledgeIncomplete: true });
    expect(store.recordings.get(id)).toMatchObject({ audioUri: undefined });
    expect(store.recordings.get(id)!.deletedAt).toBeDefined();
    expect(store.transcripts.get(id)!.segments.length).toBeGreaterThan(0);
  });

  it('reports acceptance rate per field and per template', async () => {
    const id = await recordAndExtract();
    a.draftGoals(id);
    const m = a.measurements(id).find((x) => x.motion === 'flexion' && x.side === 'left')!;
    a.edit({ kind: 'measurement', id: m.id }, PT, { value: { kind: 'number', value: 138 } });
    resolveAll(id);
    await a.sign(id, PT, { acknowledgeIncomplete: true });
    const stats = a.acceptanceStats();
    const rom = stats.byField['measure:pt.rom']!;
    expect(rom.total).toBe(4);
    expect(rom.accepted).toBe(3);
    expect(stats.byTemplate['pt.knee']!.rate).toBeLessThan(1);
  });
});
