import { describe, expect, it } from 'vitest';
import { DisciplineRegistry, type DisciplineLayer } from '../src/core/discipline.js';
import { StaticFlags } from '../src/core/flags.js';
import { LlmExtractor, ScriptedTranscriber } from '../src/core/providers.js';
import { EvalAssistant } from '../src/core/session.js';
import { createMemoryStore } from '../src/core/store.js';
import { ptLayer } from '../src/disciplines/pt/index.js';
import { MockEmr } from '../src/emr/mock.js';
import { ctxRightKnee } from './helpers.js';

/**
 * A toy OT layer built only from config + strategies. If this needs a change
 * in src/core, the extensibility requirement is broken.
 */
const otLayer: DisciplineLayer = {
  id: 'ot',
  name: 'Occupational therapy',
  measureTypes: [{ id: 'ot.grip', discipline: 'ot', name: 'Grip strength', valueKind: 'number', unit: 'kg', plausibleRange: () => ({ min: 0, max: 90 }), normal: () => 30 }],
  fields: [{ key: 'adl.dressing', label: 'Dressing', valueKind: 'text' }],
  templates: [{
    id: 'ot.hand', discipline: 'ot', name: 'Hand', version: 1, suggestFor: { icd10Prefixes: [], regions: [] },
    sections: [{ key: 'obj', title: 'Objective', fields: [
      { kind: 'finding', key: 'adl.dressing', label: 'Dressing', required: true },
      { kind: 'measures', key: 'grip', label: 'Grip', required: true, measureTypeIds: ['ot.grip'] },
    ] }],
  }],
  defaultTemplateId: 'ot.hand',
  extractors: [{
    name: 'ot.rules',
    async extract(t) {
      const seg = t.segments[0]!;
      const m = seg.text.match(/grip (\d+) kilos/);
      return {
        findings: [],
        measurements: m ? [{ measureTypeId: 'ot.grip', bodyRegion: 'hand', joint: 'hand', side: 'right', motion: null, mode: null, value: { kind: 'number', value: Number(m[1]) }, unit: 'kg', notes: null, confidence: 0.9, sourceSpan: { segmentIndex: 0, start: m.index!, end: m.index! + m[0].length, text: m[0] } }] : [],
      };
    },
  }],
  goalPatterns: [{
    id: 'ot.grip',
    draft: ({ measurements, timeframes }) => measurements.filter((m) => m.measureTypeId === 'ot.grip').map((m) => ({
      term: 'long', text: `Increase R grip to 30 kg in ${timeframes.longWeeks} weeks to open jars.`, baselineMeasurementIds: [m.id], baselineFindingKeys: [],
      targetValue: { kind: 'number', value: 30 }, timeframeWeeks: timeframes.longWeeks, functionalOutcome: 'opening jars',
    })),
  }],
  narrativeDrafters: [],
  goalTimeframes: { shortWeeks: 3, longWeeks: 6 },
  extractionPrompt: 'OT prompt',
  formatMeasurement: (m) => `grip ${(m.value as { value: number }).value} kg`,
};

describe('extensibility', () => {
  it('runs a full OT eval through the unchanged core', async () => {
    const emr = MockEmr.withTestPatient();
    emr.appointments.set('appt-ot', { ...emr.appointments.get('appt-1')!, id: 'appt-ot', discipline: 'ot', encounterId: 'enc-ot', clinicianId: 'ot-1' });
    const registry = new DisciplineRegistry();
    registry.register(ptLayer);
    registry.register(otLayer);
    const a = new EvalAssistant({ store: createMemoryStore(), registry, emr, flags: new StaticFlags(new Set(['eval_assistant', 'eval_assistant.discipline.ot', 'eval_assistant.capture', 'eval_assistant.extraction', 'eval_assistant.goals'])) });

    const s = await a.openFromAppointment('appt-ot', 'ot-1');
    expect(s.templateId).toBe('ot.hand');
    await a.captureConsent(s.id, 'signed', 'ot-1');
    const r = a.createRecorder(s.id, { upload: async () => {} });
    r.start();
    await r.stop();
    await a.finishRecording(s.id, r, new ScriptedTranscriber([{ speaker: 'clinician', text: 'Right grip 18 kilos.', startMs: 0, endMs: 1 }]));
    await a.extract(s.id);
    expect(a.completeness(s.id).map((m) => m.key)).toEqual(['adl.dressing']);
    const [goal] = a.draftGoals(s.id);
    expect(goal!.timeframeWeeks).toBe(6);
    a.confirm({ kind: 'goal', id: goal!.id }, 'ot-1');
    await a.sign(s.id, 'ot-1', { acknowledgeIncomplete: true });
    expect(emr.signedNotes[0]!.narrative).toContain('grip 18 kg');
  });

  it('rejects layers whose templates reference unknown config', () => {
    const r = new DisciplineRegistry();
    const bad = { ...otLayer, templates: [{ ...otLayer.templates[0]!, sections: [{ key: 'x', title: 'X', fields: [{ kind: 'measures' as const, key: 'g', label: 'G', required: true, measureTypeIds: ['ot.nope'] }] }] }] };
    expect(() => r.register(bad)).toThrow(/unknown measure type/);
  });
});

describe('LlmExtractor', () => {
  it('builds its prompt from the layer and sends no patient demographics', async () => {
    let sent = { system: '', user: '' };
    const ex = new LlmExtractor({ async completeJson(system, user) { sent = { system, user }; return { findings: [], measurements: [] }; } }, ptLayer);
    await ex.extract({ sessionId: 's', segments: [{ speaker: 'patient', text: 'hi', startMs: 0, endMs: 1 }] }, ctxRightKnee);
    expect(sent.system).toContain('pt.rom');
    expect(sent.system).toContain('subjective.patient_goals');
    expect(sent.user).not.toContain(ctxRightKnee.patient.name);
    expect(sent.user).not.toContain(ctxRightKnee.patient.dob);
    expect(sent.user).toContain('M17.11');
  });

  it('rejects malformed model output', async () => {
    const ex = new LlmExtractor({ async completeJson() { return { nope: true }; } }, ptLayer);
    await expect(ex.extract({ sessionId: 's', segments: [] }, ctxRightKnee)).rejects.toThrow(/invalid shape/);
  });
});
