import { describe, expect, it } from 'vitest';
import { parseObjective } from '../src/disciplines/pt/objective.js';
import { clin, ctxNoSide, ctxRightKnee } from './helpers.js';

const brief = (ms: ReturnType<typeof parseObjective>) =>
  ms.map((m) => ({ type: m.measureTypeId, side: m.side, joint: m.joint, motion: m.motion, mode: m.mode, value: m.value }));

describe('ROM (FR-OBJ-1)', () => {
  it('parses the PRD example into two structured records', () => {
    const ms = parseObjective(clin('Right knee flexion 95 active, 105 passive.'), ctxNoSide);
    expect(brief(ms)).toEqual([
      { type: 'pt.rom', side: 'right', joint: 'knee', motion: 'flexion', mode: 'active', value: { kind: 'number', value: 95 } },
      { type: 'pt.rom', side: 'right', joint: 'knee', motion: 'flexion', mode: 'passive', value: { kind: 'number', value: 105 } },
    ]);
    expect(ms.every((m) => m.confidence! >= 0.9)).toBe(true);
    expect(ms[0]!.sourceSpan).toMatchObject({ segmentIndex: 0, text: 'Right knee flexion 95 active' });
  });

  it('handles mode-before-value, AROM/PROM and "degrees"', () => {
    const ms = parseObjective(clin('AROM left shoulder flexion 150 degrees, PROM 165.'), ctxNoSide);
    expect(brief(ms).map((m) => [m.side, m.joint, m.motion, m.mode, m.value])).toEqual([
      ['left', 'shoulder', 'flexion', 'active', { kind: 'number', value: 150 }],
      ['left', 'shoulder', 'flexion', 'passive', { kind: 'number', value: 165 }],
    ]);
  });

  it('reads "lacking 5" as -5 and carries joint/side within the sentence', () => {
    const ms = parseObjective(clin('Right knee flexion 120 active and extension lacking 5 active.'), ctxNoSide);
    expect(ms[1]).toMatchObject({ motion: 'extension', side: 'right', value: { kind: 'number', value: -5 } });
  });

  it('distinguishes multi-word motions', () => {
    const ms = parseObjective(clin('Left hip internal rotation 20 passive, external rotation 40 passive.'), ctxNoSide);
    expect(ms.map((m) => m.motion)).toEqual(['internal rotation', 'external rotation']);
  });

  it('implies the ankle from dorsiflexion', () => {
    const ms = parseObjective(clin('Right dorsiflexion 5 active.'), ctxNoSide);
    expect(ms[0]).toMatchObject({ joint: 'ankle', side: 'right' });
  });

  it('ignores numbers that are not degrees', () => {
    expect(parseObjective(clin('Knee has been bothering her for 3 weeks.'), ctxNoSide)).toEqual([]);
    expect(parseObjective(clin('Right knee flexion, she says pain is 6 out of 10.'), ctxNoSide)).toEqual([]);
  });

  it('only parses clinician speech', () => {
    const ms = parseObjective([{ speaker: 'patient', text: 'My right knee bends to about 90.', startMs: 0, endMs: 1 }], ctxNoSide);
    expect(ms).toEqual([]);
  });
});

describe('never invent (FR-EXT-5)', () => {
  it('leaves side null and lowers confidence when unstated and no referral side', () => {
    const [m] = parseObjective(clin('Knee flexion 100 active.'), ctxNoSide);
    expect(m!.side).toBeNull();
    expect(m!.confidence!).toBeLessThan(0.8);
  });

  it('uses referral laterality only as a flagged assumption', () => {
    const [m] = parseObjective(clin('Knee flexion 100 active.'), ctxRightKnee);
    expect(m!.side).toBe('right');
    expect(m!.assumed).toMatch(/referral/);
  });

  it('leaves mode null when not stated', () => {
    const [m] = parseObjective(clin('Right knee flexion 100.'), ctxNoSide);
    expect(m!.mode).toBeNull();
    expect(m!.confidence!).toBeLessThan(0.8);
  });

  it('drops values it cannot place on a joint', () => {
    expect(parseObjective(clin('Flexion is 100.'), ctxNoSide)).toEqual([]);
  });

  it('does not treat a spine motion as needing a side', () => {
    const [m] = parseObjective(clin('Lumbar flexion 40 active.'), ctxNoSide);
    expect(m).toMatchObject({ joint: 'lumbar', side: null, confidence: 0.95 });
  });
});

describe('MMT (FR-OBJ-2)', () => {
  it('parses grades with +/− and muscle names', () => {
    const ms = parseObjective(clin('Quad strength 4 minus out of 5 on the right, 5 out of 5 on the left.'), ctxNoSide);
    expect(brief(ms)).toEqual([
      { type: 'pt.mmt', side: 'right', joint: 'knee', motion: 'extension', mode: null, value: { kind: 'grade', grade: 4, modifier: '-' } },
      { type: 'pt.mmt', side: 'left', joint: 'knee', motion: 'extension', mode: null, value: { kind: 'grade', grade: 5, modifier: null } },
    ]);
  });

  it('parses "4+/5" and bilateral', () => {
    const ms = parseObjective(clin('Hip abduction strength 4+/5 bilaterally.'), ctxNoSide);
    expect(ms[0]).toMatchObject({ side: 'bilateral', joint: 'hip', motion: 'abduction', value: { grade: 4, modifier: '+' } });
  });
});

describe('special tests', () => {
  it('assigns a shared result to a list of tests', () => {
    const ms = parseObjective(clin('Lachman and anterior drawer negative on the right.'), ctxNoSide);
    expect(ms.map((m) => [m.motion, m.side, m.value])).toEqual([
      ['Lachman', 'right', { kind: 'result', result: 'negative' }],
      ['Anterior drawer', 'right', { kind: 'result', result: 'negative' }],
    ]);
  });

  it('handles result-first phrasing and mixed results', () => {
    const ms = parseObjective(clin('Negative Lachman, positive McMurray on the left.'), ctxNoSide);
    expect(ms.map((m) => [m.motion, (m.value as { result: string }).result])).toEqual([
      ['Lachman', 'negative'],
      ['McMurray', 'positive'],
    ]);
  });

  it('keeps side for straight leg raise', () => {
    const [m] = parseObjective(clin('Straight leg raise positive on the left.'), ctxNoSide);
    expect(m).toMatchObject({ joint: 'lumbar', side: 'left', value: { result: 'positive' } });
  });
});
