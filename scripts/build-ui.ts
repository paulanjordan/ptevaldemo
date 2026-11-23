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
await a.draftNarratives(s.id);
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
  // Only the transcript lines that a narrative cites; the transcript itself stays hidden.
  segments: Object.fromEntries(a.findings(s.id).flatMap((f) => f.parts ?? []).flatMap((p) => p.evidence)
    .flatMap((e) => (e.kind === 'transcript' && transcript[e.segmentIndex] ? [[e.segmentIndex, transcript[e.segmentIndex]]] : []))),
  queue: a.confirmQueue(s.id).map((q) => q.ref.id),
}).replace(/</g, '\\u003c');

const src = new URL('../ui/review.src.html', import.meta.url);
const out = new URL('../ui/review.html', import.meta.url);
const page = readFileSync(src, 'utf8').replace('/*DATA*/null', data);
writeFileSync(out, page);

// Standalone copy for static hosting (Vercel): the artifact viewer adds the
// document skeleton itself, a plain web host does not.
const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${page}
</body>
</html>
`;
writeFileSync(new URL('../ui/index.html', import.meta.url), standalone);
console.log(`wrote ui/review.html and ui/index.html (${data.length} bytes of session data)`);
