import type { Store } from './store.js';
import type { AuditEvent } from './types.js';
import { newId, type Clock } from './ids.js';

/** Every AI fill and every clinician edit is logged with before/after. */
export class AuditLog {
  constructor(private store: Store, private clock: Clock) {}
  record(e: Omit<AuditEvent, 'id' | 'at'>): AuditEvent {
    return this.store.audit.put({ ...e, id: newId(), at: this.clock().toISOString() });
  }
  forSession(sessionId: string): AuditEvent[] {
    return this.store.audit.where((a) => a.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at));
  }
}
