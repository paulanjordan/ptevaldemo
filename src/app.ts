import { DisciplineRegistry } from './core/discipline.js';
import { StaticFlags, type FeatureFlags, type FlagName } from './core/flags.js';
import type { Clock } from './core/ids.js';
import { EvalAssistant } from './core/session.js';
import { createMemoryStore, type Store } from './core/store.js';
import type { RetentionPolicy } from './core/types.js';
import { ptLayer } from './disciplines/pt/index.js';
import type { EmrAdapter } from './emr/adapter.js';
import { MockEmr } from './emr/mock.js';

export const MVP_FLAGS: FlagName[] = [
  'eval_assistant',
  'eval_assistant.discipline.pt',
  'eval_assistant.capture',
  'eval_assistant.extraction',
  'eval_assistant.goals',
  'eval_assistant.narratives',
];

export function createRegistry(): DisciplineRegistry {
  const r = new DisciplineRegistry();
  r.register(ptLayer);
  return r;
}

export function createApp(opts: { emr?: EmrAdapter; flags?: FeatureFlags; store?: Store; clock?: Clock; retention?: RetentionPolicy } = {}) {
  const emr = opts.emr ?? MockEmr.withTestPatient();
  const store = opts.store ?? createMemoryStore();
  const assistant = new EvalAssistant({
    store,
    registry: createRegistry(),
    emr,
    flags: opts.flags ?? new StaticFlags(new Set(MVP_FLAGS)),
    clock: opts.clock,
    retention: opts.retention,
  });
  return { assistant, emr, store };
}
