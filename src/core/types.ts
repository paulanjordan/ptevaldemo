/**
 * Shared data model for the AI documentation core.
 *
 * Nothing in this file is discipline-specific. Disciplines extend the model by
 * registering MeasureTypes, clinical field keys and Templates (config), never by
 * adding entities here. See PRD "Data model".
 */

export type Discipline = string; // "pt", later "ot", "slp" ...
export type Side = 'left' | 'right' | 'bilateral';
export type Origin = 'ai' | 'clinician';
export type ItemStatus = 'pending' | 'confirmed' | 'edited' | 'rejected';
export type SessionStatus = 'draft' | 'in_review' | 'signed';

/** Character span inside one transcript segment (FR-EXT-2). */
export interface SourceSpan {
  segmentIndex: number;
  start: number; // char offset within segment text
  end: number;
  text: string;
}

export interface EvalSession {
  id: string;
  patientId: string;
  appointmentId: string;
  encounterId: string;
  clinicianId: string;
  discipline: Discipline;
  templateId: string;
  status: SessionStatus;
  startedAt: string;
  signedAt?: string;
  /** EMR context loaded at open (FR-EXT-4). */
  context: EmrContext;
}

export interface EmrContext {
  patient: { id: string; name: string; dob: string; sex?: string };
  referral?: {
    diagnosisCode: string; // ICD-10
    diagnosisText: string;
    side?: Side;
    referringProvider: string;
  };
  precautions: string[];
  surgicalHistory: string[];
}

export type ConsentType = 'verbal' | 'signed';
export interface Consent {
  sessionId: string;
  type: ConsentType;
  capturedBy: string;
  capturedAt: string;
}

export type RetentionPolicy =
  | { kind: 'delete_on_sign' }
  | { kind: 'delete_after_days'; days: number }
  | { kind: 'keep' };

export interface Recording {
  sessionId: string;
  audioUri?: string;
  durationMs: number;
  retentionPolicy: RetentionPolicy;
  deleteAfter?: string;
  deletedAt?: string;
}

export type Speaker = 'clinician' | 'patient';
export interface TranscriptSegment {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
}
export interface Transcript {
  sessionId: string;
  segments: TranscriptSegment[];
}

/** Common review fields shared by Findings, Measurements and Goals. */
export interface Reviewable {
  id: string;
  sessionId: string;
  origin: Origin;
  status: ItemStatus;
  confidence: number | null; // null for clinician-entered
  sourceSpan: SourceSpan | null;
  /** Why the item is in the confirm queue, if it is. */
  flags: ReviewFlag[];
}

export type ReviewFlag =
  | { kind: 'low_confidence'; detail?: string }
  | { kind: 'conflict'; withIds: string[] }
  | { kind: 'out_of_range'; detail: string }
  | { kind: 'assumed_from_context'; detail: string };

/**
 * Subjective / narrative data. Keyed by a template-independent clinical
 * field key (e.g. "pain.worst"), NOT by template section, so switching
 * templates never loses data (FR-TPL-2).
 */
export interface Finding extends Reviewable {
  fieldKey: string;
  value: unknown;
}

export type MeasureMode = 'active' | 'passive';
export interface Measurement extends Reviewable {
  measureTypeId: string;
  bodyRegion: string | null;
  joint: string | null;
  side: Side | null;
  motion: string | null;
  mode: MeasureMode | null;
  /** Shape is defined by MeasureType.valueSchema. */
  value: MeasureValue;
  unit: string | null;
  notes: string | null;
}

export type MeasureValue =
  | { kind: 'number'; value: number }
  | { kind: 'grade'; grade: number; modifier: '+' | '-' | null } // MMT 0-5 with +/-
  | { kind: 'result'; result: 'positive' | 'negative' | 'equivocal' }
  | { kind: 'text'; text: string };

export type GoalTerm = 'short' | 'long';
export interface Goal extends Reviewable {
  term: GoalTerm;
  text: string;
  /** One or more baselines (PRD FR-GOAL-2; the PRD table had a single id). */
  baselineMeasurementIds: string[];
  baselineFindingKeys: string[];
  targetValue: MeasureValue | null;
  timeframeWeeks: number;
  functionalOutcome: string | null;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  actor: string; // clinician id, or "ai:<component>"
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  at: string;
}

// ---------------------------------------------------------------------------
// Registries (configuration supplied by discipline layers)
// ---------------------------------------------------------------------------

export interface MeasureType {
  id: string;
  discipline: Discipline;
  name: string;
  valueKind: MeasureValue['kind'];
  unit: string | null;
  /** Plausible range for validation (FR-OBJ-4), may depend on joint/motion. */
  plausibleRange?: (m: Pick<Measurement, 'joint' | 'motion' | 'side'>) => { min: number; max: number } | null;
  /** Reference "normal" used by goal drafting, may depend on joint/motion. */
  normal?: (m: Pick<Measurement, 'joint' | 'motion'>) => number | null;
}

export type TemplateField =
  | { kind: 'finding'; key: string; label: string; required: boolean }
  | {
      kind: 'measures';
      key: string;
      label: string;
      required: boolean;
      measureTypeIds: string[];
      /** Restrict to these joints/regions; empty = any. */
      joints?: string[];
    };

export interface TemplateSection {
  key: string;
  title: string;
  fields: TemplateField[];
}

export interface Template {
  id: string;
  discipline: Discipline;
  name: string;
  version: number;
  sections: TemplateSection[];
  /** ICD-10 prefixes / body regions used for suggestion (FR-TPL-2). */
  suggestFor: { icd10Prefixes: string[]; regions: string[] };
}

export interface ClinicalFieldDef {
  key: string;
  label: string;
  valueKind: 'text' | 'text[]' | 'number';
}
