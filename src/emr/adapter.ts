import type { Consent, EmrContext, Goal, Measurement } from '../core/types.js';

/**
 * The only way the module touches chart data. In production this wraps the
 * EMR's internal APIs or service layer (open question: internal API vs shared
 * DB vs FHIR). Reads happen at session open; writes happen only on consent
 * capture and on sign (FR-REV-3: no silent writes).
 */
export interface EmrAdapter {
  getAppointment(appointmentId: string): Promise<Appointment>;
  loadContext(patientId: string, appointmentId: string): Promise<EmrContext>;
  writeConsent(encounterId: string, consent: Consent): Promise<void>;
  writeSignedEval(payload: SignedEvalPayload): Promise<{ noteId: string }>;
}

export interface Appointment {
  id: string;
  patientId: string;
  encounterId: string;
  clinicianId: string;
  discipline: string;
  visitType: 'initial_eval' | 're_eval' | 'treatment';
  startsAt: string;
}

export interface SignedEvalPayload {
  sessionId: string;
  patientId: string;
  encounterId: string;
  clinicianId: string;
  signedAt: string;
  templateId: string;
  templateVersion: number;
  narrative: string;
  /** Discrete fields: key → value, from confirmed findings. */
  fields: Record<string, unknown>;
  measurements: Measurement[];
  goals: Goal[];
}
