import type { Template, TemplateSection } from '../../core/types.js';

/** MVP templates: general ortho, lumbar, knee. Pure data (FR-TPL-1). */

const subjective = (extraRequired: string[] = []): TemplateSection => ({
  key: 'subjective',
  title: 'Subjective',
  fields: [
    { kind: 'finding', key: 'subjective.chief_complaint', label: 'Chief complaint', required: true },
    { kind: 'finding', key: 'subjective.mechanism', label: 'Mechanism / onset', required: extraRequired.includes('subjective.mechanism') },
    { kind: 'finding', key: 'subjective.occupation', label: 'Occupation', required: false },
    { kind: 'finding', key: 'pain.location', label: 'Pain location', required: true },
    { kind: 'finding', key: 'pain.current', label: 'Pain now', required: false },
    { kind: 'finding', key: 'pain.best', label: 'Pain at best', required: false },
    { kind: 'finding', key: 'pain.worst', label: 'Pain at worst', required: true },
    { kind: 'finding', key: 'pain.aggravating', label: 'Aggravating factors', required: false },
    { kind: 'finding', key: 'pain.easing', label: 'Easing factors', required: false },
    { kind: 'finding', key: 'subjective.plof', label: 'Prior level of function', required: true },
    { kind: 'finding', key: 'subjective.patient_goals', label: 'Patient goals', required: true },
  ],
});

const assessmentAndPlan: TemplateSection[] = [
  {
    key: 'assessment',
    title: 'Assessment',
    fields: [{ kind: 'finding', key: 'assessment.summary', label: 'Assessment', required: true }],
  },
  {
    key: 'plan',
    title: 'Plan',
    fields: [
      { kind: 'finding', key: 'plan.frequency', label: 'Frequency / duration', required: true },
      { kind: 'finding', key: 'plan.interventions', label: 'Interventions', required: false },
    ],
  },
];

export const PT_TEMPLATES: Template[] = [
  {
    id: 'pt.general_ortho',
    discipline: 'pt',
    name: 'General orthopedic',
    version: 1,
    suggestFor: { icd10Prefixes: [], regions: [] },
    sections: [
      subjective(),
      {
        key: 'objective',
        title: 'Objective',
        fields: [
          { kind: 'finding', key: 'objective.observation', label: 'Observation', required: false },
          { kind: 'finding', key: 'objective.gait', label: 'Gait', required: false },
          { kind: 'measures', key: 'rom', label: 'ROM', required: true, measureTypeIds: ['pt.rom'] },
          { kind: 'measures', key: 'mmt', label: 'Strength (MMT)', required: true, measureTypeIds: ['pt.mmt'] },
          { kind: 'measures', key: 'special', label: 'Special tests', required: false, measureTypeIds: ['pt.special_test'] },
          { kind: 'measures', key: 'other', label: 'Other measures', required: false, measureTypeIds: ['pt.girth', 'pt.tug', 'pt.reflex', 'pt.sensation', 'pt.lefs', 'pt.odi'] },
        ],
      },
      ...assessmentAndPlan,
    ],
  },
  {
    id: 'pt.knee',
    discipline: 'pt',
    name: 'Knee',
    version: 1,
    suggestFor: { icd10Prefixes: ['M17', 'M22', 'M23', 'M25.36', 'M25.46', 'M25.56', 'M25.66', 'S83', 'S80', 'S89'], regions: ['knee'] },
    sections: [
      subjective(['subjective.mechanism']),
      {
        key: 'objective',
        title: 'Objective',
        fields: [
          { kind: 'finding', key: 'objective.observation', label: 'Observation (effusion, incision)', required: false },
          { kind: 'finding', key: 'objective.gait', label: 'Gait', required: true },
          { kind: 'measures', key: 'knee_rom', label: 'Knee ROM', required: true, measureTypeIds: ['pt.rom'], joints: ['knee'] },
          { kind: 'measures', key: 'le_rom', label: 'Other LE ROM', required: false, measureTypeIds: ['pt.rom'], joints: ['hip', 'ankle'] },
          { kind: 'measures', key: 'le_mmt', label: 'LE strength (MMT)', required: true, measureTypeIds: ['pt.mmt'], joints: ['knee', 'hip', 'ankle'] },
          { kind: 'measures', key: 'knee_special', label: 'Knee special tests', required: true, measureTypeIds: ['pt.special_test'], joints: ['knee'] },
          { kind: 'measures', key: 'girth', label: 'Girth', required: false, measureTypeIds: ['pt.girth'] },
          { kind: 'measures', key: 'function', label: 'Functional tests / outcome measures', required: false, measureTypeIds: ['pt.tug', 'pt.lefs'] },
        ],
      },
      ...assessmentAndPlan,
    ],
  },
  {
    id: 'pt.lumbar',
    discipline: 'pt',
    name: 'Lumbar spine',
    version: 1,
    suggestFor: { icd10Prefixes: ['M54.4', 'M54.5', 'M51', 'M48.06', 'M47.8', 'M43.1', 'S33'], regions: ['lumbar'] },
    sections: [
      subjective(),
      {
        key: 'objective',
        title: 'Objective',
        fields: [
          { kind: 'finding', key: 'objective.observation', label: 'Posture / observation', required: false },
          { kind: 'finding', key: 'objective.gait', label: 'Gait', required: false },
          { kind: 'measures', key: 'lumbar_rom', label: 'Lumbar ROM', required: true, measureTypeIds: ['pt.rom'], joints: ['lumbar'] },
          { kind: 'measures', key: 'hip_rom', label: 'Hip ROM', required: false, measureTypeIds: ['pt.rom'], joints: ['hip'] },
          { kind: 'measures', key: 'le_mmt', label: 'LE strength / myotomes', required: true, measureTypeIds: ['pt.mmt'] },
          { kind: 'measures', key: 'neuro', label: 'Reflexes / sensation', required: false, measureTypeIds: ['pt.reflex', 'pt.sensation'] },
          { kind: 'measures', key: 'special', label: 'Special tests (SLR, slump, ...)', required: true, measureTypeIds: ['pt.special_test'] },
          { kind: 'measures', key: 'outcome', label: 'Outcome measures', required: false, measureTypeIds: ['pt.odi'] },
        ],
      },
      ...assessmentAndPlan,
    ],
  },
];
