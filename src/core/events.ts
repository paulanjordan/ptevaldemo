/** Minimal domain event bus. `eval.signed` lets plan of care, billing etc. react. */
export interface EvalSignedEvent {
  type: 'eval.signed';
  sessionId: string;
  patientId: string;
  encounterId: string;
  discipline: string;
  signedBy: string;
  signedAt: string;
  goalIds: string[];
  measurementIds: string[];
}
export type DomainEvent = EvalSignedEvent;

export class EventBus {
  private handlers: Array<(e: DomainEvent) => void> = [];
  subscribe(h: (e: DomainEvent) => void): () => void {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }
  emit(e: DomainEvent): void {
    for (const h of this.handlers) h(e);
  }
}
