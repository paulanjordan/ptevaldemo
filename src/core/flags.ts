/** Each milestone ships behind a flag (PRD "MVP scope and milestones"). */
export type FlagName =
  | 'eval_assistant'          // module visible at all
  | `eval_assistant.discipline.${string}` // one per discipline layer
  | 'eval_assistant.capture'  // M2 recording
  | 'eval_assistant.extraction' // M3
  | 'eval_assistant.goals'    // M4 goal generator
  | 'eval_assistant.narratives' // AI-drafted assessment
  | 'eval_assistant.live';    // post-MVP live drafting

export interface FeatureFlags {
  isEnabled(flag: FlagName, ctx: { orgId?: string; clinicianId?: string }): boolean;
}

export class StaticFlags implements FeatureFlags {
  constructor(private enabled: Set<FlagName>) {}
  isEnabled(flag: FlagName): boolean {
    return this.enabled.has(flag);
  }
}

export class FeatureDisabledError extends Error {
  constructor(flag: FlagName) {
    super(`feature disabled: ${flag}`);
  }
}
