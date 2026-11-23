# PT Evaluation Assistant: prototype

A standalone prototype of the **shared AI documentation core** and the **PT discipline layer** from the PRD *PT Evaluation Assistant (EMR Module)*. It runs against a mock EMR so the domain logic can be built and reviewed before integration with the real EMR.

```bash
npm install
npm test           # 65 tests
npm run typecheck
npm run demo       # end-to-end eval on the synthetic test patient
npm run db:check   # applies migrations to a throwaway Postgres 16 and tests DB guards
npm run ui:build   # rebuilds ui/review.html from real pipeline output
```

## UI prototype

`ui/review.html` is a clickable prototype of the PT flow: appointment, consent, recording, review and sign. Open it in a browser. It is built from `ui/review.src.html` plus the real pipeline output for the synthetic patient, so what you see is what the extractor and goal engine produced.

- **The transcript is hidden.** The PT records, stops and gets a drafted note. The quote button on each item shows only the words it came from and when they were said. The transcript is still stored, because it is what links each item back to its source.
- **Review rail:** items needing review come first, and conflicting values are shown side by side so the PT keeps one. The rail also lists empty required fields and draft goals.
- **Sign bar:** stays at the bottom of the screen. Signing is blocked until flagged items and goals are resolved. Signing with empty required fields needs an explicit checkbox.
- **Other parts:** a template switcher that never drops data, and a body-diagram manual entry that checks values against plausible ranges.

The UI is a prototype only: its edits stay in the browser and are not wired to the core service.

## Layout

```
src/core/               shared core (no discipline logic)
  types.ts              data model
  discipline.ts         DisciplineLayer contract + registry (validation, template suggestion)
  session.ts            EvalAssistant: open → consent → record → extract → review → goals → sign
  extraction.ts         dedupe, conflict detection, range checks, confidence flags
  recording.ts          recorder state machine, AES-256-GCM offline buffer
  providers.ts          STT / LLM ports + stubs (vendor pending BAA)
  audit.ts events.ts flags.ts store.ts
src/disciplines/pt/     PT layer: config + strategies only
  measureTypes.ts       ROM/MMT/special tests/girth/TUG/... + clinical field keys
  templates.ts          general ortho, knee, lumbar (data)
  objective.ts          spoken-measurement parser
  subjective.ts         pain ratings, patient goals, PLOF, plan, ...
  goals.ts              ROM, strength, pain, TUG goal patterns
src/emr/                EmrAdapter port + MockEmr with one synthetic patient
db/migrations/          Postgres schema with consent / lock / append-only triggers
```

## AI-drafted assessment

After extraction and goal drafting, `draftNarratives` writes the **Assessment** from the whole visit: the transcript, every finding and measure, the draft goals, and the referral. It has five paragraphs:

1. **Presentation:** age, sex, referral, chief complaint, onset and pain.
2. **Impairments:** measured deficits compared with the other side, plus effusion and gait.
3. **Functional limitations:** contrasted with prior level of function and work demands.
4. **Clinical impression:** special tests and consistency with the referral diagnosis. This paragraph is marked as needing the PT's judgment.
5. **Goals and need for skilled PT:** the patient's goals, why skilled PT is needed, and the plan.

Safeguards:
- **Cited sources:** each paragraph lists the items it was written from ("Based on N" in the UI).
- **Number check:** a number that doesn't appear in a paragraph's sources, or a citation to an item that doesn't exist, raises a `Check this claim` flag at the top of the review queue.
- **PT approval:** the assessment always goes to the review queue, and the note can't be signed until the PT approves or edits it.
- **No overwriting:** re-drafting never replaces text the PT wrote or edited.
- **Excluded items:** rejected items, and conflicting values the PT hasn't resolved, are left out.

There are two drafters behind one interface (`NarrativeDrafter`):
- **`RuleAssessmentDrafter`** (default) composes the assessment from the structured data. The demo and UI use it.
- **`LlmAssessmentDrafter`** sends the visit to an LLM with a PT-specific prompt (`ASSESSMENT_SYSTEM_PROMPT`), using short references such as M3 and T7 instead of ids, with no name or date of birth. It is enabled with `withAiAssessment(client)`. `src/providers/claude.ts` is a ready Claude client for this, kept off until a vendor is approved under a BAA.

## How it maps to the PRD

| Requirement | Where | Tested in |
| --- | --- | --- |
| FR-REC-1 start from appointment | `EvalAssistant.openFromAppointment` | session.test |
| FR-REC-2 consent gate | `captureConsent`, `Recorder.start`, DB trigger | session, recording, db-check |
| FR-REC-3/4 pause, offline buffer, encryption | `Recorder`, `EncryptedChunkBuffer` | recording.test |
| FR-REC-5 speaker-labeled transcript | `SpeechToTextProvider` (stub) | demo |
| FR-REC-6 retention | `applyRetention` | session.test |
| FR-EXT-1..5 extraction, provenance, confidence, EMR context, no invention | `extraction.ts`, PT parsers | parser + session tests |
| FR-OBJ-1/2/4 structured measures, ranges | `objective.ts`, `measureTypes.ts` | objective-parser.test |
| FR-OBJ-3 manual entry | `addMeasurement` (API only, no UI) | session.test |
| FR-TPL-1/2/4 templates as data, suggest/switch, completeness | `templates.ts`, `suggestTemplate`, `completeness` | session.test |
| FR-GOAL-1..4 | `goals.ts`, `draftGoals`, `addGoal` | session.test |
| FR-REV-1..4 queue, provenance in preview, sign, write-back, audit | `confirmQueue`, `previewNote`, `sign` | session.test |
| Extensibility (new discipline, no core changes) | `DisciplineLayer` | extensibility.test (toy OT layer) |
| Observability: acceptance per field/template | `acceptanceStats` | session.test |
| Feature flag per milestone | `flags.ts` | session.test |

## PRD gaps resolved here (please confirm)

1. **Findings use clinical keys, not template sections.** Findings are keyed by `pain.worst`, `subjective.patient_goals` and so on. Templates point at those keys, so switching templates never loses data. Anything the new template has no slot for shows under "Other findings".
2. **Goals can have several baselines.** A goal carries `baselineMeasurementIds[]` and `baselineFindingKeys[]`, stored in a `goal_baseline` join table.
3. **The completeness panel runs after the session**, because extraction is after-session only in v1.
4. **The transcript is kept after audio is deleted on sign**, so source links still work.
5. **Signed sessions are locked**, both in the app and by database triggers. Addenda are not designed yet.

## Assumptions (from the PRD's open questions)

- Extraction runs after the session only.
- The PT must resolve only flagged items. Unflagged AI items are accepted by the final signature, and each acceptance is audited as `clinician.accept_on_sign`.
- Draft goals must each be accepted, edited or rejected before signing.
- Signing with empty required fields needs an explicit acknowledgement.
- Audio is deleted on sign by default. The policy is configurable.
- Goals are not drafted from a conflicting value until the PT resolves it.
- Side is never guessed. If it isn't stated, the referral's side is used and the item goes to the confirm queue as an assumption. With no referral side, it stays empty.
- Goal targets and timeframes (STG 4 weeks, LTG 8 weeks) and the "normal" ROM values are **placeholders for clinical leads to review**.

## What is stubbed or not built

- **Speech-to-text and LLM vendors.** These are interfaces only. `LlmExtractor` builds its prompt from the PT layer and sends no name or date of birth, but no vendor is connected until one is approved under a BAA.
- **Narrative fields.** The rule-based extractor handles numbers, sides, grades and short quoted phrases well. Narrative fields (chief complaint, assessment) are left for the LLM extractor or the PT.
- **Parser limits.** Spoken number words for degrees ("ninety-five") and range forms ("0 to 95") are not handled.
- **Persistence.** It's in memory behind a `Store` port. The SQL schema is real and tested, but there is no Postgres-backed `Store` yet.
- **Not built:** a production UI (the prototype in `ui/` is not connected to the service), a live EMR adapter, outcome-measure item scoring, re-eval comparison and org template customization. The last three are post-MVP.
