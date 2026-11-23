/**
 * Runs the real pipeline on the synthetic knee eval and builds the UI
 * prototype: injects the review state into ui/review.src.html → ui/review.html.
 * Adds one re-measurement line so the confirm queue shows a conflict.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { ScriptedTranscriber } from '../src/core/providers.js';
import { KNEE_EVAL_TRANSCRIPT } from '../src/fixtures.js';
import { ptLayer } from '../src/disciplines/pt/index.js';

const PT = 'pt-1';
const { assistant: a } = createApp();
const transcript = [
  ...KNEE_EVAL_TRANSCRIPT,
  { speaker: 'clinician' as const, text: 'Rechecking the left side, left knee flexion 130 active.', startMs: 330_000, endMs: 336_000 },
];
const s = await a.openFromAppointment('appt-1', PT);
await a.captureConsent(s.id, 'verbal', PT);
const r = a.createRecorder(s.id, { upload: async () => {} });
r.start();
r.capture(new Uint8Array(8), 41 * 60_000 + 12_000);
await r.stop();
await a.finishRecording(s.id, r, new ScriptedTranscriber(transcript));
await a.extract(s.id);
const goals = a.draftGoals(s.id);
const mts = new Map(ptLayer.measureTypes.map((m) => [m.id, m]));

const at = (span: { segmentIndex: number } | null) => {
  if (!span) return null;
  const seg = transcript[span.segmentIndex]!;
  return { speaker: seg.speaker, ms: seg.startMs };
};
const data = JSON.stringify({
  session: { templateId: s.templateId, context: s.context, durationMs: r.durationMs },
  fields: ptLayer.fields,
  templates: ptLayer.templates.map((t) => ({ id: t.id, name: t.name, sections: t.sections })),
  findings: a.findings(s.id).map((f) => ({ ...f, at: at(f.sourceSpan) })),
  measurements: a.measurements(s.id).map((m) => ({ ...m, display: ptLayer.formatMeasurement(m, mts.get(m.measureTypeId)), at: at(m.sourceSpan) })),
  goals,
  queue: a.confirmQueue(s.id).map((q) => q.ref.id),
}).replace(/</g, '\\u003c');

const src = new URL('../ui/review.src.html', import.meta.url);
const out = new URL('../ui/review.html', import.meta.url);
writeFileSync(out, readFileSync(src, 'utf8').replace('/*DATA*/null', data));
console.log(`wrote ui/review.html (${data.length} bytes of session data)`);
