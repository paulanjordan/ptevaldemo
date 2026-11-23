import type { Consent, EmrContext } from '../core/types.js';
import type { Appointment, EmrAdapter, SignedEvalPayload } from './adapter.js';

/** In-memory EMR with one synthetic test patient (no real PHI). */
export class MockEmr implements EmrAdapter {
  appointments = new Map<string, Appointment>();
  contexts = new Map<string, EmrContext>();
  consents: Array<{ encounterId: string; consent: Consent }> = [];
  signedNotes: Array<SignedEvalPayload & { noteId: string }> = [];
  failWrites = false;

  static withTestPatient(): MockEmr {
    const emr = new MockEmr();
    emr.appointments.set('appt-1', {
      id: 'appt-1',
      patientId: 'pat-test-1',
      encounterId: 'enc-1',
      clinicianId: 'pt-1',
      discipline: 'pt',
      visitType: 'initial_eval',
      startsAt: '2026-11-23T15:00:00Z',
    });
    emr.contexts.set('pat-test-1', {
      patient: { id: 'pat-test-1', name: 'Test Patient', dob: '1971-04-02', sex: 'F' },
      referral: {
        diagnosisCode: 'M17.11',
        diagnosisText: 'Unilateral primary osteoarthritis, right knee',
        side: 'right',
        referringProvider: 'Dr. Example Ortho',
      },
      precautions: ['No impact activities'],
      surgicalHistory: ['Right knee arthroscopy (2019)'],
    });
    return emr;
  }

  async getAppointment(id: string): Promise<Appointment> {
    const a = this.appointments.get(id);
    if (!a) throw new Error(`appointment not found: ${id}`);
    return a;
  }
  async loadContext(patientId: string): Promise<EmrContext> {
    const c = this.contexts.get(patientId);
    if (!c) throw new Error(`patient not found: ${patientId}`);
    return structuredClone(c);
  }
  async writeConsent(encounterId: string, consent: Consent): Promise<void> {
    this.consents.push({ encounterId, consent });
  }
  async writeSignedEval(p: SignedEvalPayload): Promise<{ noteId: string }> {
    if (this.failWrites) throw new Error('EMR write failed');
    const noteId = `note-${this.signedNotes.length + 1}`;
    this.signedNotes.push({ ...structuredClone(p), noteId });
    return { noteId };
  }
}
