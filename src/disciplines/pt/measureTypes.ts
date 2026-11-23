import type { ClinicalFieldDef, MeasureType } from '../../core/types.js';

/**
 * Reference values are placeholders for clinical-lead review. Plausible ranges
 * are deliberately wide: they catch dictation/ASR errors ("knee flexion 950"),
 * not clinical abnormality.
 */
type RomRef = { normal: number; min: number; max: number };
const ROM: Record<string, RomRef> = {
  'knee|flexion': { normal: 135, min: 0, max: 160 },
  'knee|extension': { normal: 0, min: -60, max: 20 },
  'hip|flexion': { normal: 120, min: 0, max: 145 },
  'hip|extension': { normal: 20, min: -30, max: 45 },
  'hip|abduction': { normal: 45, min: 0, max: 70 },
  'hip|adduction': { normal: 30, min: 0, max: 50 },
  'hip|internal rotation': { normal: 45, min: 0, max: 70 },
  'hip|external rotation': { normal: 45, min: 0, max: 80 },
  'ankle|dorsiflexion': { normal: 20, min: -30, max: 45 },
  'ankle|plantarflexion': { normal: 50, min: 0, max: 80 },
  'ankle|inversion': { normal: 35, min: 0, max: 60 },
  'ankle|eversion': { normal: 15, min: 0, max: 40 },
  'shoulder|flexion': { normal: 180, min: 0, max: 190 },
  'shoulder|extension': { normal: 60, min: 0, max: 90 },
  'shoulder|abduction': { normal: 180, min: 0, max: 190 },
  'shoulder|internal rotation': { normal: 70, min: 0, max: 100 },
  'shoulder|external rotation': { normal: 90, min: -20, max: 120 },
  'elbow|flexion': { normal: 150, min: 0, max: 165 },
  'elbow|extension': { normal: 0, min: -60, max: 20 },
  'cervical|flexion': { normal: 50, min: 0, max: 80 },
  'cervical|extension': { normal: 60, min: 0, max: 90 },
  'cervical|rotation': { normal: 80, min: 0, max: 100 },
  'cervical|lateral flexion': { normal: 45, min: 0, max: 60 },
  'lumbar|flexion': { normal: 60, min: 0, max: 110 },
  'lumbar|extension': { normal: 25, min: 0, max: 50 },
  'lumbar|lateral flexion': { normal: 25, min: 0, max: 50 },
  'lumbar|rotation': { normal: 30, min: 0, max: 60 },
};
const romRef = (joint: string | null, motion: string | null) => (joint && motion ? ROM[`${joint}|${motion}`] : undefined);

export const PT_MEASURE_TYPES: MeasureType[] = [
  {
    id: 'pt.rom',
    discipline: 'pt',
    name: 'Range of motion (goniometric)',
    valueKind: 'number',
    unit: 'deg',
    plausibleRange: (m) => {
      const r = romRef(m.joint, m.motion);
      return r ? { min: r.min, max: r.max } : { min: -90, max: 200 };
    },
    normal: (m) => romRef(m.joint, m.motion)?.normal ?? null,
  },
  { id: 'pt.mmt', discipline: 'pt', name: 'Manual muscle test', valueKind: 'grade', unit: null, plausibleRange: () => ({ min: 0, max: 5 }), normal: () => 5 },
  { id: 'pt.special_test', discipline: 'pt', name: 'Special test', valueKind: 'result', unit: null },
  { id: 'pt.girth', discipline: 'pt', name: 'Girth', valueKind: 'number', unit: 'cm', plausibleRange: () => ({ min: 5, max: 120 }) },
  { id: 'pt.tug', discipline: 'pt', name: 'Timed Up and Go', valueKind: 'number', unit: 's', plausibleRange: () => ({ min: 3, max: 180 }), normal: () => 13.5 },
  { id: 'pt.reflex', discipline: 'pt', name: 'Deep tendon reflex', valueKind: 'text', unit: null },
  { id: 'pt.sensation', discipline: 'pt', name: 'Sensation', valueKind: 'text', unit: null },
  // Outcome measures: manual total entry in MVP; item scoring (FR-OBJ-5) is post-MVP.
  { id: 'pt.lefs', discipline: 'pt', name: 'Lower Extremity Functional Scale', valueKind: 'number', unit: 'pts', plausibleRange: () => ({ min: 0, max: 80 }), normal: () => 80 },
  { id: 'pt.odi', discipline: 'pt', name: 'Oswestry Disability Index', valueKind: 'number', unit: '%', plausibleRange: () => ({ min: 0, max: 100 }), normal: () => 0 },
];

/** Template-independent clinical field keys for subjective / narrative data. */
export const PT_FIELDS: ClinicalFieldDef[] = [
  { key: 'subjective.chief_complaint', label: 'Chief complaint', valueKind: 'text' },
  { key: 'subjective.mechanism', label: 'Mechanism of injury / onset', valueKind: 'text' },
  { key: 'subjective.occupation', label: 'Occupation', valueKind: 'text' },
  { key: 'pain.location', label: 'Pain location', valueKind: 'text' },
  { key: 'pain.current', label: 'Pain now (0–10)', valueKind: 'number' },
  { key: 'pain.best', label: 'Pain at best (0–10)', valueKind: 'number' },
  { key: 'pain.worst', label: 'Pain at worst (0–10)', valueKind: 'number' },
  { key: 'pain.aggravating', label: 'Aggravating factors', valueKind: 'text[]' },
  { key: 'pain.easing', label: 'Easing factors', valueKind: 'text[]' },
  { key: 'subjective.plof', label: 'Prior level of function', valueKind: 'text[]' },
  { key: 'subjective.patient_goals', label: 'Patient goals', valueKind: 'text[]' },
  { key: 'objective.observation', label: 'Observation', valueKind: 'text[]' },
  { key: 'objective.gait', label: 'Gait', valueKind: 'text[]' },
  { key: 'assessment.summary', label: 'Assessment', valueKind: 'text' },
  { key: 'plan.frequency', label: 'Frequency / duration', valueKind: 'text' },
  { key: 'plan.interventions', label: 'Planned interventions', valueKind: 'text[]' },
];
