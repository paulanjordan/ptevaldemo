import { describe, expect, it } from 'vitest';
import { Recorder } from '../src/core/recording.js';
import type { AudioChunk } from '../src/core/providers.js';

function flakyUploader() {
  const got: AudioChunk[] = [];
  return { online: true, got, async upload(_s: string, c: AudioChunk) { if (!this.online) throw new Error('offline'); got.push(c); } };
}

describe('Recorder (FR-REC-2/3/4)', () => {
  it('refuses to start without consent', () => {
    const r = new Recorder('s', flakyUploader(), () => false);
    expect(() => r.start()).toThrow(/consent/);
  });

  it('never captures paused audio', async () => {
    const up = flakyUploader();
    const r = new Recorder('s', up, () => true);
    r.start();
    expect(r.capture(new Uint8Array([1]), 100)).toBe(true);
    r.pause();
    expect(r.capture(new Uint8Array([2]), 100)).toBe(false);
    r.resume();
    r.capture(new Uint8Array([3]), 100);
    await r.stop();
    expect(up.got.map((c) => c.bytes[0])).toEqual([1, 3]);
    expect(r.durationMs).toBe(200);
  });

  it('buffers through a network drop and resumes upload in order', async () => {
    const up = flakyUploader();
    const r = new Recorder('s', up, () => true);
    r.start();
    up.online = false;
    for (let i = 0; i < 3; i++) r.capture(new Uint8Array([i]), 100);
    expect(await r.flush()).toEqual({ uploaded: 0, pending: 3 });
    up.online = true;
    expect(await r.flush()).toEqual({ uploaded: 3, pending: 0 });
    expect(up.got.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it('stores buffered audio encrypted, not in plaintext', () => {
    const r = new Recorder('s', flakyUploader(), () => true);
    r.start();
    const plain = Buffer.from('patient audio frame '.repeat(4));
    r.capture(new Uint8Array(plain), 100);
    const stored = r.buffer.rawStored()[0]!;
    expect(stored.equals(plain)).toBe(false);
    expect(stored.includes(Buffer.from('patient audio'))).toBe(false);
    expect(Buffer.from(r.buffer.peek()!.bytes).equals(plain)).toBe(true);
  });
});
