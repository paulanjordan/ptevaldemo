import { randomUUID } from 'node:crypto';
export const newId = (): string => randomUUID();
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
