import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AudioChunk } from './providers.js';

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

/** Where finished chunks go (object storage in production). */
export interface AudioUploader {
  upload(sessionId: string, chunk: AudioChunk): Promise<void>;
}

/**
 * Encrypted on-device buffer (FR-REC-4). AES-256-GCM with a per-session key
 * held in memory only; ciphertext is what would be written to IndexedDB /
 * device storage so a lost tablet does not expose audio.
 */
export class EncryptedChunkBuffer {
  private key = randomBytes(32);
  private items: Array<{ seq: number; iv: Buffer; tag: Buffer; data: Buffer; startMs: number; durationMs: number }> = [];

  push(c: AudioChunk): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(c.bytes), cipher.final()]);
    this.items.push({ seq: c.seq, iv, tag: cipher.getAuthTag(), data, startMs: c.startMs, durationMs: c.durationMs });
  }

  peek(): AudioChunk | undefined {
    const it = this.items[0];
    if (!it) return undefined;
    const d = createDecipheriv('aes-256-gcm', this.key, it.iv);
    d.setAuthTag(it.tag);
    const bytes = Buffer.concat([d.update(it.data), d.final()]);
    return { seq: it.seq, startMs: it.startMs, durationMs: it.durationMs, bytes: new Uint8Array(bytes) };
  }

  shift(): void {
    this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  /** Raw stored bytes, for asserting nothing is held in plaintext. */
  rawStored(): Buffer[] {
    return this.items.map((i) => i.data);
  }
}

/**
 * Recorder state machine. Paused audio is discarded at the source
 * (FR-REC-3); every captured chunk goes through the encrypted buffer and is
 * removed only after a successful upload, so network drops lose nothing.
 */
export class Recorder {
  state: RecorderState = 'idle';
  private seq = 0;
  private capturedMs = 0;
  readonly uploaded: AudioChunk[] = [];
  readonly buffer = new EncryptedChunkBuffer();

  constructor(
    private sessionId: string,
    private uploader: AudioUploader,
    private hasConsent: () => boolean,
  ) {}

  start(): void {
    if (!this.hasConsent()) throw new Error('consent required before recording (FR-REC-2)');
    if (this.state !== 'idle') throw new Error(`cannot start from ${this.state}`);
    this.state = 'recording';
  }
  pause(): void {
    if (this.state !== 'recording') throw new Error(`cannot pause from ${this.state}`);
    this.state = 'paused';
  }
  resume(): void {
    if (this.state !== 'paused') throw new Error(`cannot resume from ${this.state}`);
    this.state = 'recording';
  }
  async stop(): Promise<void> {
    if (this.state !== 'recording' && this.state !== 'paused') throw new Error(`cannot stop from ${this.state}`);
    this.state = 'stopped';
    await this.flush();
  }

  /** Called by the mic pipeline for every audio frame batch. */
  capture(bytes: Uint8Array, durationMs: number): boolean {
    if (this.state !== 'recording') return false; // paused/stopped audio is never captured
    this.buffer.push({ seq: this.seq++, startMs: this.capturedMs, durationMs, bytes });
    this.capturedMs += durationMs;
    return true;
  }

  /** Upload buffered chunks in order; stops at first failure and keeps the rest. */
  async flush(): Promise<{ uploaded: number; pending: number }> {
    let n = 0;
    for (let c = this.buffer.peek(); c; c = this.buffer.peek()) {
      try {
        await this.uploader.upload(this.sessionId, c);
      } catch {
        break;
      }
      this.buffer.shift();
      this.uploaded.push(c);
      n++;
    }
    return { uploaded: n, pending: this.buffer.size };
  }

  get durationMs(): number {
    return this.capturedMs;
  }
}
