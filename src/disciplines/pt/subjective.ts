import type { FindingCandidate } from '../../core/discipline.js';
import type { TranscriptSegment } from '../../core/types.js';
import { clauses, sentences, toNumber, type Piece } from './text.js';

/**
 * Pattern-based extraction of subjective and plan fields. Deliberately
 * conservative: it quotes what was said and leaves narrative synthesis
 * (chief complaint wording, assessment) to the LLM extractor or the PT.
 */
export function parseSubjective(segments: TranscriptSegment[]): FindingCandidate[] {
  const out: FindingCandidate[] = [];
  const add = (fieldKey: string, value: unknown, confidence: number, segIdx: number, p: Piece) =>
    out.push({ fieldKey, value, confidence, sourceSpan: { segmentIndex: segIdx, start: p.start, end: p.end, text: p.text } });

  segments.forEach((seg, i) => {
    const prev = segments[i - 1];
    const askedAboutPain = prev?.speaker === 'clinician' && /\bpain\b|\bhurt|out of 10|scale/i.test(prev.text);

    for (const s of sentences(seg.text)) {
      // ---- pain ratings (either speaker) ----
      if (/\bpain\b|\bhurts?\b|out of 10|\/\s*10/i.test(s.text) || askedAboutPain) {
        for (const cl of clauses(s)) {
          const re = /\b(\d{1,2})\s*(?:out of|\/)\s*(?:10|ten)\b/gi;
          for (let m = re.exec(cl.text); m; m = re.exec(cl.text)) {
            const n = Number(m[1]);
            if (n > 10) continue;
            const q = qualifier(cl.text) ?? qualifier(s.text);
            add(q ? `pain.${q}` : 'pain.current', n, q ? 0.9 : 0.7, i, cl);
          }
        }
      }

      if (seg.speaker === 'patient') {
        let m: RegExpMatchArray | null;
        if ((m = s.text.match(/\b(?:I want to|I'd like to|I would like to|my goal is to|I wanna|I'm hoping to|I hope to|I just want to)\s+(.+)/i)))
          add('subjective.patient_goals', clean(m[1]!), 0.85, i, s);
        if ((m = s.text.match(/\b(?:before (?:this|that|the (?:injury|surgery|fall))[^,]*,?\s*I (?:could|was able to|used to)|I used to)\s+(.+)/i)))
          add('subjective.plof', clean(m[1]!), 0.8, i, s);
        if ((m = s.text.match(/\b(?:it )?(?:hurts|is worse|gets worse|it's worse|aches)\s+(?:when(?: I)?|with|if(?: I)?|going|after)\s+(.+)/i)))
          add('pain.aggravating', clean(m[1]!), 0.8, i, s);
        if ((m = s.text.match(/\b(?:feels better|it's better|is better|helps|relieves it)\s+(?:when(?: I)?|with|if(?: I)?|after)\s+(.+)/i)) ||
            (m = s.text.match(/\b((?:ice|heat|rest|ibuprofen|sitting|lying down|stretching)[^.]*?)\s+(?:helps|seems to help|makes it better)/i)))
          add('pain.easing', clean(m[1]!), 0.8, i, s);
        if ((m = s.text.match(/\b(?:the pain is|it hurts|pain's|it's)\s+(?:mostly\s+|right\s+)?(?:on|in|at|along|around)\s+(the (?:inside|outside|front|back|inner|outer|top|bottom)[^.,]*)/i)))
          add('pain.location', clean(m[1]!), 0.75, i, s);
        if ((m = s.text.match(/\bI work (?:as an?|in)\s+([^.,]+)/i))) add('subjective.occupation', clean(m[1]!), 0.85, i, s);
        if (/\b(?:started|began)\b.*\b(?:ago|when|after)\b|\b(?:twisted|fell|slipped|injured)\b/i.test(s.text))
          add('subjective.mechanism', clean(s.text), 0.7, i, s);
      }

      if (seg.speaker === 'clinician') {
        let m: RegExpMatchArray | null;
        if ((m = s.text.match(/\b(\d|one|two|three|four|five)\s*(?:times|x)\s*(?:a|per|\/)\s*week\s*for\s*(\d+|four|six|eight|ten|twelve)\s*weeks\b/i))) {
          const f = toNumber(m[1]!);
          const w = toNumber(m[2]!);
          if (f && w) add('plan.frequency', `${f}x/week for ${w} weeks`, 0.9, i, s);
        }
        if (/\b(?:we'll|we will|plan (?:is|to)|I'd like to|going to)\b/i.test(s.text)) {
          for (const [re, label] of INTERVENTIONS) if (re.test(s.text)) add('plan.interventions', label, 0.85, i, s);
        }
        if (/\b(?:swelling|effusion|edema|ecchymosis|bruising|incision|atrophy|erythema|warmth)\b/i.test(s.text) && !/\?$/.test(s.text))
          add('objective.observation', clean(s.text), 0.85, i, s);
        if (/\b(?:gait|antalgic|limp(?:ing)?|cane|walker|crutch(?:es)?|trendelenburg|assistive device)\b/i.test(s.text) && !/\?$/.test(s.text))
          add('objective.gait', clean(s.text), 0.85, i, s);
        if ((m = s.text.match(/\b(?:my assessment is|assessment:|in summary,?|overall,? (?:this is|she has|he has|they have|the patient has))\s*(.+)/i)))
          add('assessment.summary', clean(m[1] ?? s.text), 0.8, i, s);
      }
    }
  });
  return out;
}

const INTERVENTIONS: Array<[RegExp, string]> = [
  [/\btherapeutic exercise\b|\bstrengthening\b/i, 'Therapeutic exercise'],
  [/\bmanual therapy\b|\bjoint mob(?:ilization)?s?\b|\bsoft tissue\b/i, 'Manual therapy'],
  [/\bneuromuscular re-?ed(?:ucation)?\b|\bbalance training\b/i, 'Neuromuscular re-education'],
  [/\bgait training\b/i, 'Gait training'],
  [/\bhome exercise program\b|\bHEP\b/i, 'Home exercise program'],
  [/\bdry needling\b/i, 'Dry needling'],
  [/\bmodalities\b|\bice\b|\bE-?stim\b/i, 'Modalities as needed'],
];

function qualifier(t: string): 'worst' | 'best' | 'current' | null {
  if (/\bworst\b|\bbad days?\b|\bat its worst\b/i.test(t)) return 'worst';
  if (/\bbest\b|\bgood days?\b|\bat its best\b/i.test(t)) return 'best';
  if (/\bright now\b|\bnow\b|\btoday\b|\bcurrently\b|\bat rest\b/i.test(t)) return 'current';
  return null;
}

const clean = (s: string) => s.trim().replace(/[.!?;,\s]+$/, '');
