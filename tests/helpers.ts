import type { EmrContext, TranscriptSegment } from '../src/core/types.js';

export const clin = (...texts: string[]): TranscriptSegment[] =>
  texts.map((text, i) => ({ speaker: 'clinician', text, startMs: i * 1000, endMs: i * 1000 + 900 }));

export const segs = (...pairs: Array<['clinician' | 'patient', string]>): TranscriptSegment[] =>
  pairs.map(([speaker, text], i) => ({ speaker, text, startMs: i * 1000, endMs: i * 1000 + 900 }));

export const ctxNoSide: EmrContext = {
  patient: { id: 'p', name: 'Test', dob: '1970-01-01' },
  precautions: [],
  surgicalHistory: [],
};
export const ctxRightKnee: EmrContext = {
  ...ctxNoSide,
  referral: { diagnosisCode: 'M17.11', diagnosisText: 'R knee OA', side: 'right', referringProvider: 'Dr X' },
};
