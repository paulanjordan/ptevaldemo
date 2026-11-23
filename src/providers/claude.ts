import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../core/providers.js';

/**
 * LlmClient backed by Claude. Not wired in by default: enable it only once
 * the vendor is approved under a BAA (PRD open question). Credentials come
 * from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile).
 *
 *   const layer = withAiAssessment(new ClaudeLlmClient());
 */
export class ClaudeLlmClient implements LlmClient {
  constructor(
    private client = new Anthropic(),
    private model = 'claude-opus-5-5',
  ) {}

  async completeJson(system: string, user: string): Promise<unknown> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      // Clinical writing is intelligence-sensitive: keep effort at least high.
      output_config: { effort: 'high' },
      // If a safety classifier declines, retry on the routed fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: `${user}\n\nRespond with the JSON object only.` }],
    });

    if (response.stop_reason === 'refusal') throw new Error('the model declined to write this section; write it manually');
    if (response.stop_reason === 'max_tokens') throw new Error('the model response was cut off; try again');

    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try {
      return JSON.parse(json);
    } catch {
      throw new Error('the model did not return valid JSON');
    }
  }
}
