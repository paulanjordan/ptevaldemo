import { describe, expect, it } from 'vitest';
import { parseSubjective } from '../src/disciplines/pt/subjective.js';
import { segs } from './helpers.js';

const pick = (r: ReturnType<typeof parseSubjective>) => r.map((f) => [f.fieldKey, f.value]);

describe('subjective extraction', () => {
  it('extracts qualified pain ratings', () => {
    const r = parseSubjective(segs(['patient', 'At best a 2 out of 10, at worst 7 out of 10.']));
    expect(pick(r)).toEqual([['pain.best', 2], ['pain.worst', 7]]);
  });

  it('marks an unqualified rating as lower-confidence current pain', () => {
    const r = parseSubjective(segs(['clinician', 'How is your pain?'], ['patient', "It's a 5 out of 10."]));
    expect(r[0]).toMatchObject({ fieldKey: 'pain.current', value: 5 });
    expect(r[0]!.confidence!).toBeLessThan(0.8);
  });

  it('extracts patient goals and PLOF from patient speech only', () => {
    const r = parseSubjective(segs(
      ['patient', 'I want to play golf again. Before the surgery, I could walk 2 miles.'],
      ['clinician', 'I want to check your knee.'],
    ));
    expect(pick(r)).toEqual([['subjective.patient_goals', 'play golf again'], ['subjective.plof', 'walk 2 miles']]);
  });

  it('extracts plan frequency', () => {
    const r = parseSubjective(segs(['clinician', "We'll see you two times a week for six weeks."]));
    expect(pick(r)).toContainEqual(['plan.frequency', '2x/week for 6 weeks']);
  });

  it('records source spans', () => {
    const r = parseSubjective(segs(['patient', 'Hi. It hurts when I kneel.']));
    expect(r[0]!.sourceSpan).toEqual({ segmentIndex: 0, start: 4, end: 25, text: 'It hurts when I kneel' });
  });
});
