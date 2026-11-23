import type { EmrAdapter } from '../emr/adapter.js';
import { AuditLog } from './audit.js';
import type { DisciplineLayer, DisciplineRegistry } from './discipline.js';
import { EventBus } from './events.js';
import {
  DEFAULT_EXTRACTION_CONFIG,
  needsConfirmation,
  rangeFlag,
  runExtraction,
  type ExtractionConfig,
} from './extraction.js';
import { FeatureDisabledError, type FeatureFlags, type FlagName } from './flags.js';
import { newId, systemClock, type Clock } from './ids.js';
import type { SpeechToTextProvider } from './providers.js';
import { joinParts, validateNarrative, type VisitSnapshot } from './narrative.js';
import { Recorder, type AudioUploader } from './recording.js';
import type { Store } from './store.js';
import type {
  ConsentType,
  EvalSession,
  Finding,
  Goal,
  Measurement,
  RetentionPolicy,
  ReviewFlag,
  Template,
  TemplateField,
} from './types.js';

export type ItemRef = { kind: 'finding' | 'measurement' | 'goal'; id: string };
type Item = Finding | Measurement | Goal;

export interface QueueEntry {
  ref: ItemRef;
  label: string;
  flags: ReviewFlag[];
  sourceText: string | null;
}

export interface MissingField {
  sectionTitle: string;
  key: string;
  label: string;
}

export interface NoteLine {
  label: string;
  text: string;
  /** FR-REV-2 provenance marker. */
  provenance: 'ai' | 'ai_edited' | 'clinician';
  ref: ItemRef;
}
export interface NotePreview {
  sections: Array<{ title: string; lines: NoteLine[] }>;
  text: string;
}

export interface SignOptions {
  /** Required to sign while required template fields are empty. */
  acknowledgeIncomplete?: boolean;
}

export class SignBlockedError extends Error {
  constructor(public reasons: string[]) {
    super(`cannot sign: ${reasons.join('; ')}`);
  }
}

export interface EvalAssistantDeps {
  store: Store;
  registry: DisciplineRegistry;
  emr: EmrAdapter;
  flags: FeatureFlags;
  clock?: Clock;
  events?: EventBus;
  extraction?: ExtractionConfig;
  retention?: RetentionPolicy;
}

/**
 * Shared core service. One instance serves every discipline; all
 * discipline-specific behaviour comes from the DisciplineLayer.
 */
export class EvalAssistant {
  readonly audit: AuditLog;
  readonly events: EventBus;
  private clock: Clock;
  private cfg: ExtractionConfig;
  private retention: RetentionPolicy;

  constructor(private d: EvalAssistantDeps) {
    this.clock = d.clock ?? systemClock;
    this.audit = new AuditLog(d.store, this.clock);
    this.events = d.events ?? new EventBus();
    this.cfg = d.extraction ?? DEFAULT_EXTRACTION_CONFIG;
    this.retention = d.retention ?? { kind: 'delete_on_sign' };
  }

  // -------------------------------------------------------------- session --

  /** FR-REC-1: sessions start only from an appointment. */
  async openFromAppointment(appointmentId: string, clinicianId: string): Promise<EvalSession> {
    const appt = await this.d.emr.getAppointment(appointmentId);
    this.requireFlag('eval_assistant', clinicianId);
    this.requireFlag(`eval_assistant.discipline.${appt.discipline}`, clinicianId);
    if (appt.clinicianId !== clinicianId) throw new Error('clinician is not assigned to this appointment');
    if (appt.visitType !== 'initial_eval') throw new Error(`visit type ${appt.visitType} not supported in v1`);

    const existing = this.d.store.sessions.where((s) => s.appointmentId === appointmentId && s.status !== 'signed')[0];
    if (existing) return existing; // resume the autosaved draft

    const context = await this.d.emr.loadContext(appt.patientId, appointmentId);
    const template = this.d.registry.suggestTemplate(appt.discipline, context);
    const session: EvalSession = {
      id: newId(),
      patientId: appt.patientId,
      appointmentId,
      encounterId: appt.encounterId,
      clinicianId,
      discipline: appt.discipline,
      templateId: template.id,
      status: 'draft',
      startedAt: this.now(),
      context,
    };
    this.d.store.sessions.put(session);
    this.audit.record({ sessionId: session.id, actor: clinicianId, action: 'session.opened', entity: 'session', entityId: session.id, before: null, after: { templateId: template.id } });
    return session;
  }

  session(id: string): EvalSession {
    const s = this.d.store.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    return s;
  }

  layer(sessionId: string): DisciplineLayer {
    return this.d.registry.get(this.session(sessionId).discipline);
  }

  template(sessionId: string): Template {
    const s = this.session(sessionId);
    return this.d.registry.template(s.discipline, s.templateId);
  }

  /** FR-TPL-2: switching never touches findings/measurements. */
  setTemplate(sessionId: string, templateId: string, actor: string): void {
    const s = this.editable(sessionId, actor);
    this.d.registry.template(s.discipline, templateId); // validates
    const before = s.templateId;
    s.templateId = templateId;
    this.d.store.sessions.put(s);
    this.audit.record({ sessionId, actor, action: 'template.changed', entity: 'session', entityId: sessionId, before, after: templateId });
  }

  // ------------------------------------------------------ consent & capture --

  /** FR-REC-2: consent is stored locally and in the chart before recording. */
  async captureConsent(sessionId: string, type: ConsentType, clinicianId: string): Promise<void> {
    const s = this.editable(sessionId, clinicianId);
    const consent = { id: newId(), sessionId, type, capturedBy: clinicianId, capturedAt: this.now() };
    await this.d.emr.writeConsent(s.encounterId, consent);
    this.d.store.consents.put(consent);
    this.audit.record({ sessionId, actor: clinicianId, action: 'consent.captured', entity: 'consent', entityId: consent.id, before: null, after: { type } });
  }

  hasConsent(sessionId: string): boolean {
    return this.d.store.consents.where((c) => c.sessionId === sessionId).length > 0;
  }

  createRecorder(sessionId: string, uploader: AudioUploader): Recorder {
    const s = this.session(sessionId);
    this.requireFlag('eval_assistant.capture', s.clinicianId);
    return new Recorder(sessionId, uploader, () => this.hasConsent(sessionId));
  }

  /** After stop: transcribe uploaded audio and store transcript + recording. */
  async finishRecording(sessionId: string, recorder: Recorder, stt: SpeechToTextProvider): Promise<void> {
    this.editable(sessionId, null);
    if (recorder.state !== 'stopped') throw new Error('stop the recording first');
    if (recorder.buffer.size > 0) throw new Error(`${recorder.buffer.size} audio chunks not yet uploaded`);
    const segments = await stt.transcribe(recorder.uploaded);
    this.d.store.transcripts.put({ id: sessionId, sessionId, segments });
    this.d.store.recordings.put({
      id: sessionId,
      sessionId,
      audioUri: `audio://${sessionId}`,
      durationMs: recorder.durationMs,
      retentionPolicy: this.retention,
    });
    this.audit.record({ sessionId, actor: `ai:stt:${stt.name}`, action: 'transcript.created', entity: 'transcript', entityId: sessionId, before: null, after: { segments: segments.length } });
  }

  // ------------------------------------------------------------ extraction --

  async extract(sessionId: string): Promise<{ findings: Finding[]; measurements: Measurement[] }> {
    const s = this.editable(sessionId, null);
    this.requireFlag('eval_assistant.extraction', s.clinicianId);
    const transcript = this.d.store.transcripts.get(sessionId);
    if (!transcript) throw new Error('no transcript for session');

    // Re-running replaces only AI items the clinician has not touched.
    for (const f of this.d.store.findings.where((x) => x.sessionId === sessionId && x.origin === 'ai' && x.status === 'pending')) this.d.store.findings.delete(f.id);
    for (const m of this.d.store.measurements.where((x) => x.sessionId === sessionId && x.origin === 'ai' && x.status === 'pending')) this.d.store.measurements.delete(m.id);

    const r = await runExtraction(sessionId, transcript, s.context, this.d.registry.get(s.discipline), this.cfg);
    for (const f of r.findings) {
      this.d.store.findings.put(f);
      this.audit.record({ sessionId, actor: 'ai:extraction', action: 'ai.fill', entity: 'finding', entityId: f.id, before: null, after: f });
    }
    for (const m of r.measurements) {
      this.d.store.measurements.put(m);
      this.audit.record({ sessionId, actor: 'ai:extraction', action: 'ai.fill', entity: 'measurement', entityId: m.id, before: null, after: m });
    }
    s.status = 'in_review';
    this.d.store.sessions.put(s);
    return r;
  }

  findings(sessionId: string): Finding[] {
    return this.d.store.findings.where((f) => f.sessionId === sessionId);
  }
  measurements(sessionId: string): Measurement[] {
    return this.d.store.measurements.where((m) => m.sessionId === sessionId);
  }
  goals(sessionId: string): Goal[] {
    return this.d.store.goals.where((g) => g.sessionId === sessionId);
  }

  // ---------------------------------------------------------- manual entry --

  /** FR-OBJ-3: manual / body-diagram entry writes the same records. */
  addMeasurement(
    sessionId: string,
    actor: string,
    m: Omit<Measurement, 'id' | 'sessionId' | 'origin' | 'status' | 'flags' | 'confidence' | 'sourceSpan'>,
    opts: { confirmOutOfRange?: boolean } = {},
  ): Measurement {
    this.editable(sessionId, actor);
    const rec: Measurement = { ...m, id: newId(), sessionId, origin: 'clinician', status: 'confirmed', confidence: null, sourceSpan: null, flags: [] };
    const rf = rangeFlag(rec, this.d.registry.measureTypes(this.session(sessionId).discipline).get(m.measureTypeId));
    if (rf && !opts.confirmOutOfRange) throw new Error(`out of range, confirm to save: ${rf.kind === 'out_of_range' ? rf.detail : ''}`);
    this.d.store.measurements.put(rec);
    this.audit.record({ sessionId, actor, action: 'clinician.add', entity: 'measurement', entityId: rec.id, before: null, after: rec });
    return rec;
  }

  addFinding(sessionId: string, actor: string, fieldKey: string, value: unknown): Finding {
    const s = this.editable(sessionId, actor);
    if (!this.d.registry.get(s.discipline).fields.some((f) => f.key === fieldKey)) throw new Error(`unknown field ${fieldKey}`);
    const rec: Finding = { id: newId(), sessionId, fieldKey, value, origin: 'clinician', status: 'confirmed', confidence: null, sourceSpan: null, flags: [] };
    this.d.store.findings.put(rec);
    this.audit.record({ sessionId, actor, action: 'clinician.add', entity: 'finding', entityId: rec.id, before: null, after: rec });
    return rec;
  }

  // ------------------------------------------------------------ completeness --

  /** FR-TPL-4 */
  completeness(sessionId: string): MissingField[] {
    const t = this.template(sessionId);
    const findings = this.findings(sessionId).filter((f) => f.status !== 'rejected');
    const meas = this.measurements(sessionId).filter((m) => m.status !== 'rejected');
    const missing: MissingField[] = [];
    for (const sec of t.sections)
      for (const f of sec.fields) {
        if (!f.required) continue;
        const filled = f.kind === 'finding' ? findings.some((x) => x.fieldKey === f.key) : meas.some((m) => matchesField(m, f));
        if (!filled) missing.push({ sectionTitle: sec.title, key: f.key, label: f.label });
      }
    return missing;
  }

  // ------------------------------------------------------------------ goals --

  /** FR-GOAL-1/2/4 */
  draftGoals(sessionId: string): Goal[] {
    const s = this.editable(sessionId, null);
    this.requireFlag('eval_assistant.goals', s.clinicianId);
    const layer = this.d.registry.get(s.discipline);
    for (const g of this.goals(sessionId).filter((g) => g.origin === 'ai' && g.status === 'pending')) this.d.store.goals.delete(g.id);

    // Unresolved conflicts are not a usable baseline: wait for the PT to pick one.
    const usable = (i: Finding | Measurement) => i.status !== 'rejected' && !(i.status === 'pending' && i.flags.some((f) => f.kind === 'conflict'));
    const input = {
      measurements: this.measurements(sessionId).filter(usable),
      findings: this.findings(sessionId).filter(usable),
      measureTypes: this.d.registry.measureTypes(s.discipline),
      timeframes: layer.goalTimeframes,
    };
    const out: Goal[] = [];
    for (const p of layer.goalPatterns)
      for (const draft of p.draft(input)) {
        const g: Goal = { ...draft, id: newId(), sessionId, origin: 'ai', status: 'pending', confidence: null, sourceSpan: null, flags: [] };
        this.d.store.goals.put(g);
        this.audit.record({ sessionId, actor: `ai:goals:${p.id}`, action: 'ai.fill', entity: 'goal', entityId: g.id, before: null, after: g });
        out.push(g);
      }
    return out;
  }

  // ------------------------------------------------------------- narratives --

  /** Read-only view of the visit for narrative drafting. */
  visitSnapshot(sessionId: string, excludeFieldKeys: string[] = []): VisitSnapshot {
    const s = this.session(sessionId);
    const layer = this.d.registry.get(s.discipline);
    const mts = this.d.registry.measureTypes(s.discipline);
    const usable = (i: Finding | Measurement) => i.status !== 'rejected' && !(i.status === 'pending' && i.flags.some((f) => f.kind === 'conflict'));
    const findings = this.findings(sessionId).filter((f) => usable(f) && !excludeFieldKeys.includes(f.fieldKey));
    const measurements = this.measurements(sessionId).filter(usable);
    const goals = this.goals(sessionId).filter((g) => g.status !== 'rejected');
    const display = new Map<string, string>();
    for (const f of findings) display.set(f.id, `${layer.fields.find((x) => x.key === f.fieldKey)?.label ?? f.fieldKey}: ${fmtValue(f.value)}`);
    for (const m of measurements) display.set(m.id, layer.formatMeasurement(m, mts.get(m.measureTypeId)));
    for (const g of goals) display.set(g.id, g.text);
    return {
      context: s.context,
      ageYears: ageOn(s.context.patient.dob, this.clock()),
      transcript: this.d.store.transcripts.get(sessionId) ?? { sessionId, segments: [] },
      findings,
      measurements,
      goals,
      display,
    };
  }

  /**
   * Draft narrative sections (the assessment) from the whole visit. Run after
   * extraction and goal drafting. Never overwrites text the PT wrote, edited
   * or accepted; re-running replaces only an untouched AI draft.
   */
  async draftNarratives(sessionId: string): Promise<Finding[]> {
    const s = this.editable(sessionId, null);
    this.requireFlag('eval_assistant.narratives', s.clinicianId);
    const layer = this.d.registry.get(s.discipline);
    const out: Finding[] = [];
    for (const drafter of layer.narrativeDrafters) {
      const existing = this.findings(sessionId).filter((f) => f.fieldKey === drafter.fieldKey && f.status !== 'rejected');
      if (existing.some((f) => f.origin === 'clinician' || f.status !== 'pending')) continue;
      for (const f of existing) this.d.store.findings.delete(f.id);

      const visit = this.visitSnapshot(sessionId, [drafter.fieldKey]);
      const parts = await drafter.draft(visit);
      if (!parts.length) continue;
      const judgment = parts.filter((p) => p.needsJudgment).map((p) => p.heading);
      const f: Finding = {
        id: newId(),
        sessionId,
        fieldKey: drafter.fieldKey,
        value: joinParts(parts),
        parts,
        origin: 'ai',
        status: 'pending',
        confidence: null,
        sourceSpan: null,
        flags: [
          { kind: 'requires_review', detail: `AI-written from the whole visit; read before signing${judgment.length ? `. Clinical judgment to confirm: ${judgment.join(', ')}` : ''}` },
          ...validateNarrative(parts, visit),
        ],
      };
      this.d.store.findings.put(f);
      this.audit.record({ sessionId, actor: `ai:narrative:${drafter.name}`, action: 'ai.fill', entity: 'finding', entityId: f.id, before: null, after: f });
      out.push(f);
    }
    return out;
  }

  addGoal(sessionId: string, actor: string, g: Omit<Goal, 'id' | 'sessionId' | 'origin' | 'status' | 'flags' | 'confidence' | 'sourceSpan'>): Goal {
    this.editable(sessionId, actor);
    const rec: Goal = { ...g, id: newId(), sessionId, origin: 'clinician', status: 'confirmed', confidence: null, sourceSpan: null, flags: [] };
    this.d.store.goals.put(rec);
    this.audit.record({ sessionId, actor, action: 'clinician.add', entity: 'goal', entityId: rec.id, before: null, after: rec });
    return rec;
  }

  // ----------------------------------------------------------------- review --

  /** FR-REV-1: conflicts first, then out-of-range, assumptions, low confidence. */
  confirmQueue(sessionId: string): QueueEntry[] {
    const s = this.session(sessionId);
    const layer = this.d.registry.get(s.discipline);
    const mts = this.d.registry.measureTypes(s.discipline);
    const rank = (fl: ReviewFlag[]) =>
      Math.min(...fl.map((f) => ({ conflict: 0, unsupported_claim: 0, out_of_range: 1, assumed_from_context: 2, low_confidence: 3, requires_review: 3 })[f.kind]));
    const entries: Array<QueueEntry & { r: number }> = [];
    const src = (i: Item) => i.sourceSpan?.text ?? null;
    for (const f of this.findings(sessionId).filter(needsConfirmation))
      entries.push({ ref: { kind: 'finding', id: f.id }, label: `${layer.fields.find((x) => x.key === f.fieldKey)?.label ?? f.fieldKey}: ${fmtValue(f.value)}`, flags: f.flags, sourceText: src(f), r: rank(f.flags) });
    for (const m of this.measurements(sessionId).filter(needsConfirmation))
      entries.push({ ref: { kind: 'measurement', id: m.id }, label: layer.formatMeasurement(m, mts.get(m.measureTypeId)), flags: m.flags, sourceText: src(m), r: rank(m.flags) });
    entries.sort((a, b) => a.r - b.r);
    return entries.map(({ r: _r, ...e }) => e);
  }

  confirm(ref: ItemRef, actor: string): void {
    this.mutate(ref, actor, 'clinician.confirm', (i) => {
      i.status = 'confirmed';
    });
  }

  reject(ref: ItemRef, actor: string): void {
    this.mutate(ref, actor, 'clinician.reject', (i) => {
      i.status = 'rejected';
    });
  }

  /** Edit any field of an item; marks it edited and clears its review flags. */
  edit<T extends Item>(ref: ItemRef, actor: string, patch: Partial<T>): void {
    this.mutate(ref, actor, 'clinician.edit', (i) => {
      const { id: _id, sessionId: _s, origin: _o, ...allowed } = patch as Partial<Item>;
      Object.assign(i, allowed);
      i.status = i.origin === 'ai' ? 'edited' : 'confirmed';
      i.flags = [];
    });
  }

  // -------------------------------------------------------------- preview --

  previewNote(sessionId: string): NotePreview {
    const s = this.session(sessionId);
    const layer = this.d.registry.get(s.discipline);
    const t = this.template(sessionId);
    const mts = this.d.registry.measureTypes(s.discipline);
    const findings = this.findings(sessionId).filter((f) => f.status !== 'rejected');
    const meas = this.measurements(sessionId).filter((m) => m.status !== 'rejected');
    const goals = this.goals(sessionId).filter((g) => g.status !== 'rejected');
    const usedF = new Set<string>();
    const usedM = new Set<string>();
    const label = (k: string) => layer.fields.find((f) => f.key === k)?.label ?? k;

    const sections: NotePreview['sections'] = [];
    for (const sec of t.sections) {
      const lines: NoteLine[] = [];
      for (const fld of sec.fields) {
        if (fld.kind === 'finding') {
          for (const f of findings.filter((x) => x.fieldKey === fld.key)) {
            usedF.add(f.id);
            lines.push({ label: fld.label, text: fmtValue(f.value), provenance: prov(f), ref: { kind: 'finding', id: f.id } });
          }
        } else {
          for (const m of meas.filter((x) => matchesField(x, fld) && !usedM.has(x.id))) {
            usedM.add(m.id);
            lines.push({ label: fld.label, text: layer.formatMeasurement(m, mts.get(m.measureTypeId)), provenance: prov(m), ref: { kind: 'measurement', id: m.id } });
          }
        }
      }
      if (lines.length) sections.push({ title: sec.title, lines });
    }
    // Data the current template has no slot for is still shown, never dropped.
    const otherLines: NoteLine[] = [
      ...findings.filter((f) => !usedF.has(f.id)).map((f) => ({ label: label(f.fieldKey), text: fmtValue(f.value), provenance: prov(f), ref: { kind: 'finding' as const, id: f.id } })),
      ...meas.filter((m) => !usedM.has(m.id)).map((m) => ({ label: mts.get(m.measureTypeId)?.name ?? m.measureTypeId, text: layer.formatMeasurement(m, mts.get(m.measureTypeId)), provenance: prov(m), ref: { kind: 'measurement' as const, id: m.id } })),
    ];
    if (otherLines.length) sections.push({ title: 'Other findings', lines: otherLines });
    for (const term of ['short', 'long'] as const) {
      const lines = goals.filter((g) => g.term === term).map((g) => ({ label: term === 'short' ? 'STG' : 'LTG', text: g.text, provenance: prov(g), ref: { kind: 'goal' as const, id: g.id } }));
      if (lines.length) sections.push({ title: term === 'short' ? 'Short-term goals' : 'Long-term goals', lines });
    }

    const tag = { ai: '[AI]', ai_edited: '[AI, edited]', clinician: '[PT]' } as const;
    const text = sections
      .map((sec) => `## ${sec.title}\n` + sec.lines.map((l) => `- ${l.label}: ${l.text} ${tag[l.provenance]}`).join('\n'))
      .join('\n\n');
    return { sections, text };
  }

  // ------------------------------------------------------------------- sign --

  /** FR-REV-3/4: the only path that writes clinical content to the chart. */
  async sign(sessionId: string, clinicianId: string, opts: SignOptions = {}): Promise<{ noteId: string }> {
    const s = this.editable(sessionId, clinicianId);
    if (s.clinicianId !== clinicianId) throw new Error('only the session clinician can sign');

    const reasons: string[] = [];
    const queue = this.confirmQueue(sessionId);
    if (queue.length) reasons.push(`${queue.length} item(s) in the confirm queue`);
    const pendingGoals = this.goals(sessionId).filter((g) => g.status === 'pending');
    if (pendingGoals.length) reasons.push(`${pendingGoals.length} draft goal(s) not accepted, edited or rejected`);
    const missing = this.completeness(sessionId);
    if (missing.length && !opts.acknowledgeIncomplete) reasons.push(`required fields empty: ${missing.map((m) => m.label).join(', ')}`);
    if (reasons.length) throw new SignBlockedError(reasons);

    // Assumption (open question): unflagged AI items are accepted by the final signature.
    const acceptOnSign = <T extends Item>(kind: ItemRef['kind'], items: T[], put: (t: T) => void) => {
      for (const i of items.filter((x) => x.status === 'pending')) {
        i.status = 'confirmed';
        put(i);
        this.audit.record({ sessionId, actor: clinicianId, action: 'clinician.accept_on_sign', entity: kind, entityId: i.id, before: 'pending', after: 'confirmed' });
      }
    };
    acceptOnSign('finding', this.findings(sessionId), (i) => this.d.store.findings.put(i));
    acceptOnSign('measurement', this.measurements(sessionId), (i) => this.d.store.measurements.put(i));

    const keep = <T extends Item>(xs: T[]) => xs.filter((x) => x.status !== 'rejected');
    const findings = keep(this.findings(sessionId));
    const measurements = keep(this.measurements(sessionId));
    const goals = keep(this.goals(sessionId));
    const fields: Record<string, unknown> = {};
    for (const f of findings) {
      const def = this.d.registry.get(s.discipline).fields.find((x) => x.key === f.fieldKey);
      if (def?.valueKind === 'text[]') fields[f.fieldKey] = [...((fields[f.fieldKey] as unknown[]) ?? []), f.value];
      else fields[f.fieldKey] = f.value;
    }
    const signedAt = this.now();
    const t = this.template(sessionId);
    const { noteId } = await this.d.emr.writeSignedEval({
      sessionId,
      patientId: s.patientId,
      encounterId: s.encounterId,
      clinicianId,
      signedAt,
      templateId: t.id,
      templateVersion: t.version,
      narrative: this.previewNote(sessionId).text,
      fields,
      measurements,
      goals,
    });

    s.status = 'signed';
    s.signedAt = signedAt;
    this.d.store.sessions.put(s);
    this.audit.record({ sessionId, actor: clinicianId, action: 'session.signed', entity: 'session', entityId: sessionId, before: 'in_review', after: { noteId } });
    this.applyRetention(sessionId);
    this.events.emit({
      type: 'eval.signed',
      sessionId,
      patientId: s.patientId,
      encounterId: s.encounterId,
      discipline: s.discipline,
      signedBy: clinicianId,
      signedAt,
      goalIds: goals.map((g) => g.id),
      measurementIds: measurements.map((m) => m.id),
    });
    return { noteId };
  }

  /** FR-REC-6. Transcript is kept for provenance (flagged decision). */
  private applyRetention(sessionId: string): void {
    const rec = this.d.store.recordings.get(sessionId);
    if (!rec) return;
    const p = rec.retentionPolicy;
    if (p.kind === 'delete_on_sign') {
      rec.deletedAt = this.now();
      rec.audioUri = undefined;
    } else if (p.kind === 'delete_after_days') {
      rec.deleteAfter = new Date(this.clock().getTime() + p.days * 86_400_000).toISOString();
    }
    this.d.store.recordings.put(rec);
    if (rec.deletedAt) this.audit.record({ sessionId, actor: 'system:retention', action: 'audio.deleted', entity: 'recording', entityId: sessionId, before: null, after: null });
  }

  // ----------------------------------------------------------- observability --

  /** Share of AI items accepted unedited, per field and per template. */
  acceptanceStats(): { byField: Record<string, Rate>; byTemplate: Record<string, Rate> } {
    const byField: Record<string, Rate> = {};
    const byTemplate: Record<string, Rate> = {};
    const signed = new Map(this.d.store.sessions.where((s) => s.status === 'signed').map((s) => [s.id, s]));
    const bump = (map: Record<string, Rate>, k: string, accepted: boolean) => {
      const r = (map[k] ??= { accepted: 0, total: 0, rate: 0 });
      r.total++;
      if (accepted) r.accepted++;
      r.rate = r.accepted / r.total;
    };
    const items: Array<{ key: string; i: Item }> = [
      ...this.d.store.findings.all().map((f) => ({ key: f.fieldKey, i: f as Item })),
      ...this.d.store.measurements.all().map((m) => ({ key: `measure:${m.measureTypeId}`, i: m as Item })),
      ...this.d.store.goals.all().map((g) => ({ key: `goal:${g.term}`, i: g as Item })),
    ];
    for (const { key, i } of items) {
      const s = signed.get(i.sessionId);
      if (!s || i.origin !== 'ai') continue;
      const ok = i.status === 'confirmed';
      bump(byField, key, ok);
      bump(byTemplate, s.templateId, ok);
    }
    return { byField, byTemplate };
  }

  // ---------------------------------------------------------------- helpers --

  private mutate(ref: ItemRef, actor: string, action: string, fn: (i: Item) => void): void {
    const coll = { finding: this.d.store.findings, measurement: this.d.store.measurements, goal: this.d.store.goals }[ref.kind] as Store['findings'];
    const item = coll.get(ref.id) as Item | undefined;
    if (!item) throw new Error(`${ref.kind} not found: ${ref.id}`);
    this.editable(item.sessionId, actor);
    const before = structuredClone(item);
    fn(item);
    coll.put(item as Finding);
    this.audit.record({ sessionId: item.sessionId, actor, action, entity: ref.kind, entityId: ref.id, before, after: item });
  }

  /** Signed sessions are immutable (addenda are out of scope for v1). */
  private editable(sessionId: string, actor: string | null): EvalSession {
    const s = this.session(sessionId);
    if (s.status === 'signed') throw new Error('session is signed and locked');
    if (actor !== null && actor !== s.clinicianId) throw new Error('actor is not the session clinician');
    return s;
  }

  private requireFlag(flag: FlagName, clinicianId: string): void {
    if (!this.d.flags.isEnabled(flag, { clinicianId })) throw new FeatureDisabledError(flag);
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export interface Rate {
  accepted: number;
  total: number;
  rate: number;
}

function ageOn(dob: string, now: Date): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function prov(i: Item): NoteLine['provenance'] {
  if (i.origin === 'clinician') return 'clinician';
  return i.status === 'edited' ? 'ai_edited' : 'ai';
}

function matchesField(m: Measurement, f: TemplateField): boolean {
  if (f.kind !== 'measures') return false;
  if (!f.measureTypeIds.includes(m.measureTypeId)) return false;
  return !f.joints?.length || (m.joint !== null && f.joints.includes(m.joint)) || (m.bodyRegion !== null && f.joints.includes(m.bodyRegion));
}

function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmtValue).join('; ');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
