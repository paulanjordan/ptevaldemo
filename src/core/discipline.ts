import type {
  ClinicalFieldDef,
  Discipline,
  EmrContext,
  Finding,
  Goal,
  Measurement,
  MeasureType,
  Template,
  Transcript,
} from './types.js';

/**
 * A candidate produced by an extractor, before the core assigns ids,
 * validates it and decides whether it needs confirmation.
 */
export interface CandidateMeta {
  /** Set when a value came from EMR context rather than the transcript. */
  assumed?: string;
  /** Why confidence is reduced; shown in the confirm queue, never charted. */
  confidenceNote?: string;
}
export type FindingCandidate = Pick<Finding, 'fieldKey' | 'value' | 'confidence' | 'sourceSpan'> & CandidateMeta;
export type MeasurementCandidate = Omit<Measurement, 'id' | 'sessionId' | 'origin' | 'status' | 'flags'> & CandidateMeta;

export interface ExtractionResult {
  findings: FindingCandidate[];
  measurements: MeasurementCandidate[];
}

/** Turns a transcript into candidates for one discipline's schema. */
export interface Extractor {
  readonly name: string;
  extract(transcript: Transcript, ctx: EmrContext): Promise<ExtractionResult>;
}

export type GoalDraft = Omit<Goal, 'id' | 'sessionId' | 'origin' | 'status' | 'flags' | 'confidence' | 'sourceSpan'>;

export interface GoalDraftInput {
  measurements: Measurement[];
  findings: Finding[];
  measureTypes: Map<string, MeasureType>;
  timeframes: { shortWeeks: number; longWeeks: number };
}

/** A goal pattern inspects confirmed/pending data and proposes goals. */
export interface GoalPattern {
  id: string;
  draft(input: GoalDraftInput): GoalDraft[];
}

/**
 * Everything a discipline supplies. Configuration and pluggable strategies only:
 * the core never branches on discipline id.
 */
export interface DisciplineLayer {
  id: Discipline;
  name: string;
  measureTypes: MeasureType[];
  fields: ClinicalFieldDef[];
  templates: Template[];
  defaultTemplateId: string;
  extractors: Extractor[];
  goalPatterns: GoalPattern[];
  goalTimeframes: { shortWeeks: number; longWeeks: number };
  /** Instructions for an LLM extractor, assembled from this layer's schema. */
  extractionPrompt: string;
  /** Render a value for the narrative note. */
  formatMeasurement(m: Measurement, mt: MeasureType | undefined): string;
}

export class DisciplineRegistry {
  private layers = new Map<Discipline, DisciplineLayer>();

  register(layer: DisciplineLayer): void {
    if (this.layers.has(layer.id)) throw new Error(`discipline already registered: ${layer.id}`);
    const ids = new Set<string>();
    for (const mt of layer.measureTypes) {
      if (mt.discipline !== layer.id) throw new Error(`measure type ${mt.id} belongs to ${mt.discipline}`);
      ids.add(mt.id);
    }
    const fieldKeys = new Set(layer.fields.map((f) => f.key));
    for (const t of layer.templates) {
      for (const s of t.sections)
        for (const f of s.fields) {
          if (f.kind === 'finding' && !fieldKeys.has(f.key))
            throw new Error(`template ${t.id} references unknown field ${f.key}`);
          if (f.kind === 'measures')
            for (const id of f.measureTypeIds)
              if (!ids.has(id)) throw new Error(`template ${t.id} references unknown measure type ${id}`);
        }
    }
    if (!layer.templates.some((t) => t.id === layer.defaultTemplateId))
      throw new Error(`default template ${layer.defaultTemplateId} not found`);
    this.layers.set(layer.id, layer);
  }

  get(id: Discipline): DisciplineLayer {
    const l = this.layers.get(id);
    if (!l) throw new Error(`unknown discipline: ${id}`);
    return l;
  }

  template(discipline: Discipline, templateId: string): Template {
    const t = this.get(discipline).templates.find((x) => x.id === templateId);
    if (!t) throw new Error(`unknown template ${templateId} for ${discipline}`);
    return t;
  }

  measureTypes(discipline: Discipline): Map<string, MeasureType> {
    return new Map(this.get(discipline).measureTypes.map((m) => [m.id, m]));
  }

  /** FR-TPL-2: suggest from referral ICD-10 code, falling back to default. */
  suggestTemplate(discipline: Discipline, ctx: EmrContext): Template {
    const layer = this.get(discipline);
    const code = ctx.referral?.diagnosisCode.toUpperCase().replace('.', '') ?? '';
    let best: { t: Template; len: number } | null = null;
    for (const t of layer.templates)
      for (const p of t.suggestFor.icd10Prefixes) {
        const pp = p.toUpperCase().replace('.', '');
        if (code.startsWith(pp) && (!best || pp.length > best.len)) best = { t, len: pp.length };
      }
    return best?.t ?? this.template(discipline, layer.defaultTemplateId);
  }
}
