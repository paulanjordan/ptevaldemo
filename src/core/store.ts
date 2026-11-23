import type {
  AuditEvent,
  Consent,
  EvalSession,
  Finding,
  Goal,
  Measurement,
  Recording,
  Transcript,
} from './types.js';

/**
 * Persistence port. The prototype ships an in-memory implementation; the
 * Postgres schema it mirrors is in db/migrations. In the real EMR this would be
 * backed by the EMR's own data layer.
 */
export interface Store {
  sessions: Collection<EvalSession>;
  consents: Collection<Consent & { id: string }>;
  recordings: Collection<Recording & { id: string }>;
  transcripts: Collection<Transcript & { id: string }>;
  findings: Collection<Finding>;
  measurements: Collection<Measurement>;
  goals: Collection<Goal>;
  audit: Collection<AuditEvent>;
}

export interface Collection<T extends { id: string }> {
  get(id: string): T | undefined;
  put(item: T): T;
  delete(id: string): void;
  where(pred: (t: T) => boolean): T[];
  all(): T[];
}

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  private m = new Map<string, T>();
  get(id: string) {
    const v = this.m.get(id);
    return v ? structuredClone(v) : undefined;
  }
  put(item: T) {
    this.m.set(item.id, structuredClone(item));
    return item;
  }
  delete(id: string) {
    this.m.delete(id);
  }
  where(pred: (t: T) => boolean) {
    return [...this.m.values()].filter(pred).map((v) => structuredClone(v));
  }
  all() {
    return this.where(() => true);
  }
}

export function createMemoryStore(): Store {
  return {
    sessions: new MemoryCollection(),
    consents: new MemoryCollection(),
    recordings: new MemoryCollection(),
    transcripts: new MemoryCollection(),
    findings: new MemoryCollection(),
    measurements: new MemoryCollection(),
    goals: new MemoryCollection(),
    audit: new MemoryCollection(),
  };
}
