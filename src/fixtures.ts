import type { TranscriptSegment } from './core/types.js';

/** Synthetic knee eval transcript (no real patient data). */
const lines: Array<[TranscriptSegment['speaker'], string]> = [
  ['clinician', "So what brings you in today?"],
  ['patient', "My right knee has been really stiff and sore. It started about three months ago when I twisted it stepping off a curb."],
  ['clinician', "How would you rate your pain?"],
  ['patient', "Right now it's about a 4 out of 10. At its worst it's an 8 out of 10, and at best maybe 2 out of 10."],
  ['patient', "It hurts when I go down stairs. Ice helps a lot."],
  ['patient', "The pain is mostly on the inside of the knee."],
  ['clinician', "What were you doing before this happened?"],
  ['patient', "Before this, I could hike 5 miles on weekends. I work as a middle school teacher, so I'm on my feet all day."],
  ['clinician', "What would you like to get back to?"],
  ['patient', "I want to climb the stairs at school without holding the rail. I'd like to get back to hiking with my daughter."],
  ['clinician', "Gait is antalgic with decreased stance time on the right, no assistive device. Mild effusion noted at the right knee."],
  ['clinician', "Right knee flexion 95 active, 105 passive. Extension lacking 5 actively."],
  ['clinician', "Left knee flexion 135 active."],
  ['clinician', "Quad strength 4 minus out of 5 on the right, 5 out of 5 on the left. Hip abduction 4 out of 5 bilaterally."],
  ['clinician', "Lachman and anterior drawer negative on the right. McMurray positive on the right."],
  ['clinician', "Plan is 2 times a week for 8 weeks. We'll do therapeutic exercise, manual therapy and a home exercise program."],
];

export const KNEE_EVAL_TRANSCRIPT: TranscriptSegment[] = lines.map(([speaker, text], i) => ({
  speaker,
  text,
  startMs: i * 20_000,
  endMs: i * 20_000 + 15_000,
}));
