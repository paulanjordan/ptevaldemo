import type { DisciplineLayer, ExtractionResult, Extractor } from './discipline.js';
import type { EmrContext, Transcript, TranscriptSegment } from './types.js';

/**
 * Vendor ports. Which STT / LLM vendors are approved under a BAA is an open
 * question, so only interfaces and stubs live here. A real adapter must:
 *  - be covered by a signed BAA with a no-training clause,
 *  - use TLS 1.2+, and
 *  - receive the minimum necessary PHI (no demographics in prompts).
 */
export interface AudioChunk {
  seq: number;
  startMs: number;
  durationMs: number;
  bytes: Uint8Array;
}

export interface SpeechToTextProvider {
  readonly name: string;
  /** Returns diarized segments (FR-REC-5). */
  transcribe(chunks: AudioChunk[]): Promise<TranscriptSegment[]>;
}

/** Test/demo transcriber that returns a fixed script regardless of audio. */
export class ScriptedTranscriber implements SpeechToTextProvider {
  readonly name = 'scripted';
  constructor(private segments: TranscriptSegment[]) {}
  async transcribe(): Promise<TranscriptSegment[]> {
    return this.segments;
  }
}

export interface LlmClient {
  /** Must return JSON matching ExtractionResult. */
  completeJson(system: string, user: string): Promise<unknown>;
}

/**
 * LLM-backed extractor. Prompt comes entirely from the discipline layer, so the
 * core stays discipline-agnostic. Not wired to a vendor until one is approved.
 */
export class LlmExtractor implements Extractor {
  readonly name = 'llm';
  constructor(private client: LlmClient, private layer: DisciplineLayer) {}

  async extract(transcript: Transcript, ctx: EmrContext): Promise<ExtractionResult> {
    const user = JSON.stringify({
      // Minimum necessary: clinical context only, no name / DOB.
      referral: ctx.referral ? { code: ctx.referral.diagnosisCode, text: ctx.referral.diagnosisText, side: ctx.referral.side } : null,
      precautions: ctx.precautions,
      surgicalHistory: ctx.surgicalHistory,
      segments: transcript.segments.map((s, i) => ({ i, speaker: s.speaker, text: s.text })),
    });
    const raw = await this.client.completeJson(this.layer.extractionPrompt, user);
    return validateExtraction(raw);
  }
}

function validateExtraction(raw: unknown): ExtractionResult {
  const r = raw as Partial<ExtractionResult> | null;
  if (!r || !Array.isArray(r.findings) || !Array.isArray(r.measurements))
    throw new Error('LLM extraction returned an invalid shape');
  return { findings: r.findings, measurements: r.measurements };
}
