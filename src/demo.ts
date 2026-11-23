/**
 * End-to-end demo against the mock EMR test patient:
 * open → consent → record → transcribe → extract → confirm queue → goals → sign.
 */
import { createApp } from './app.js';
import { ScriptedTranscriber } from './core/providers.js';
import { KNEE_EVAL_TRANSCRIPT } from './fixtures.js';
import { MockEmr } from './emr/mock.js';

const emr = MockEmr.withTestPatient();
const { assistant } = createApp({ emr });
const PT = 'pt-1';

const session = await assistant.openFromAppointment('appt-1', PT);
console.log(`Session ${session.id}: template suggested from ${session.context.referral?.diagnosisCode} → ${session.templateId}`);

await assistant.captureConsent(session.id, 'verbal', PT);
const rec = assistant.createRecorder(session.id, { upload: async () => {} });
rec.start();
for (let i = 0; i < 5; i++) rec.capture(new Uint8Array(1024), 9 * 60_000);
await rec.stop();
await assistant.finishRecording(session.id, rec, new ScriptedTranscriber(KNEE_EVAL_TRANSCRIPT));

const { findings, measurements } = await assistant.extract(session.id);
console.log(`\nExtracted ${findings.length} findings and ${measurements.length} measurements.`);

console.log('\nConfirm queue:');
for (const q of assistant.confirmQueue(session.id))
  console.log(`  - ${q.label}  [${q.flags.map((f) => f.kind).join(', ')}]  ← "${q.sourceText}"`);

console.log('\nMissing required fields:', assistant.completeness(session.id).map((m) => m.label).join(', ') || 'none');

// PT works the queue: confirm everything flagged (a real PT would check each one).
for (const q of assistant.confirmQueue(session.id)) assistant.confirm(q.ref, PT);
// PT fills what the assistant left empty.
assistant.addFinding(session.id, PT, 'subjective.chief_complaint', 'R knee pain and stiffness limiting stairs and hiking');

const goals = assistant.draftGoals(session.id);
const [assessment] = await assistant.draftNarratives(session.id);
console.log(`\nDrafted assessment (needs PT review):\n${assessment!.value}`);
assistant.confirm({ kind: 'finding', id: assessment!.id }, PT);
console.log(`\nDrafted ${goals.length} goals:`);
for (const g of goals) console.log(`  ${g.term === 'short' ? 'STG' : 'LTG'}: ${g.text}`);
for (const g of goals) assistant.confirm({ kind: 'goal', id: g.id }, PT);

console.log('\n' + assistant.previewNote(session.id).text);

assistant.events.subscribe((e) => console.log(`\nevent ${e.type}: ${e.measurementIds.length} measurements, ${e.goalIds.length} goals`));
const { noteId } = await assistant.sign(session.id, PT);
console.log(`Signed → ${noteId}. EMR received ${emr.signedNotes[0]!.measurements.length} discrete measurements.`);
console.log(`Audit events: ${assistant.audit.forSession(session.id).length}`);
