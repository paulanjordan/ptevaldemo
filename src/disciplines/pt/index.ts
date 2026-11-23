import type { DisciplineLayer, Extractor } from '../../core/discipline.js';
import type { Measurement, MeasureType } from '../../core/types.js';
import { fmtGrade, PT_GOAL_PATTERNS } from './goals.js';
import { PT_FIELDS, PT_MEASURE_TYPES } from './measureTypes.js';
import { parseObjective } from './objective.js';
import { parseSubjective } from './subjective.js';
import { PT_TEMPLATES } from './templates.js';

export const ptRuleExtractor: Extractor = {
  name: 'pt.rules',
  async extract(transcript, ctx) {
    return {
      measurements: parseObjective(transcript.segments, ctx),
      findings: parseSubjective(transcript.segments),
    };
  },
};

function formatMeasurement(m: Measurement, mt: MeasureType | undefined): string {
  const side = m.side === 'right' ? 'R ' : m.side === 'left' ? 'L ' : m.side === 'bilateral' ? 'B ' : '';
  const mode = m.mode === 'active' ? ' AROM' : m.mode === 'passive' ? ' PROM' : '';
  switch (m.value.kind) {
    case 'number':
      if (m.measureTypeId === 'pt.rom') return `${side}${m.joint} ${m.motion}${mode} ${m.value.value}°`;
      return `${mt?.name ?? m.measureTypeId}${m.joint ? ` (${side}${m.joint})` : ''}: ${m.value.value}${m.unit ? ` ${m.unit}` : ''}`;
    case 'grade':
      return `${side}${m.joint} ${m.motion} ${fmtGrade(m.value)}`;
    case 'result':
      return `${side}${m.motion ?? 'special test'}: ${m.value.result}`;
    case 'text':
      return `${mt?.name ?? m.measureTypeId}${m.joint ? ` (${side}${m.joint})` : ''}: ${m.value.text}`;
  }
}

const extractionPrompt = [
  'You extract findings from a physical therapy initial evaluation transcript.',
  'Return JSON {"findings": [...], "measurements": [...]}.',
  'Rules: use only what was said. Never infer or estimate unstated values; omit them.',
  'Every item must include sourceSpan {segmentIndex, start, end, text} quoting the transcript, and a confidence 0..1.',
  `Finding fieldKey must be one of: ${PT_FIELDS.map((f) => `${f.key} (${f.valueKind})`).join(', ')}.`,
  `Measurement measureTypeId must be one of: ${PT_MEASURE_TYPES.map((m) => `${m.id} (${m.valueKind}${m.unit ? `, ${m.unit}` : ''})`).join(', ')}.`,
  'Measurement fields: bodyRegion, joint, side (left|right|bilateral|null), motion, mode (active|passive|null), value, unit, notes.',
].join('\n');

export const ptLayer: DisciplineLayer = {
  id: 'pt',
  name: 'Physical therapy',
  measureTypes: PT_MEASURE_TYPES,
  fields: PT_FIELDS,
  templates: PT_TEMPLATES,
  defaultTemplateId: 'pt.general_ortho',
  extractors: [ptRuleExtractor],
  goalPatterns: PT_GOAL_PATTERNS,
  goalTimeframes: { shortWeeks: 4, longWeeks: 8 },
  extractionPrompt,
  formatMeasurement,
};
