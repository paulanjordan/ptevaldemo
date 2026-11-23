-- AI documentation core: initial schema (PRD "Data model").
-- Proposed names; adapt to the EMR's schema conventions once known.
-- patient_id / encounter_id / clinician_id reference EMR tables not present here.

CREATE SCHEMA IF NOT EXISTS eval_assistant;
SET search_path TO eval_assistant;

-- ---------------------------------------------------------------- registries
CREATE TABLE measure_type (
  id            text PRIMARY KEY,               -- 'pt.rom'
  discipline    text NOT NULL,
  name          text NOT NULL,
  value_kind    text NOT NULL CHECK (value_kind IN ('number', 'grade', 'result', 'text')),
  unit          text,
  reference     jsonb NOT NULL DEFAULT '{}'::jsonb  -- plausible ranges / normals, by joint|motion
);

CREATE TABLE template (
  id            text NOT NULL,
  version       int  NOT NULL,
  discipline    text NOT NULL,
  name          text NOT NULL,
  sections      jsonb NOT NULL,
  suggest_for   jsonb NOT NULL DEFAULT '{}'::jsonb,
  org_id        text,                            -- NULL = shipped template; set = org customization (post-MVP)
  PRIMARY KEY (id, version)
);

-- ------------------------------------------------------------------ sessions
CREATE TABLE eval_session (
  id               uuid PRIMARY KEY,
  patient_id       text NOT NULL,
  appointment_id   text NOT NULL,
  encounter_id     text NOT NULL,
  clinician_id     text NOT NULL,
  discipline       text NOT NULL,
  template_id      text NOT NULL,
  template_version int  NOT NULL,
  status           text NOT NULL CHECK (status IN ('draft', 'in_review', 'signed')),
  context          jsonb NOT NULL,             -- EMR snapshot at open (referral, precautions)
  started_at       timestamptz NOT NULL,
  signed_at        timestamptz,
  FOREIGN KEY (template_id, template_version) REFERENCES template (id, version),
  CHECK ((status = 'signed') = (signed_at IS NOT NULL))
);
-- One open draft per appointment.
CREATE UNIQUE INDEX eval_session_one_open_per_appt ON eval_session (appointment_id) WHERE status <> 'signed';

CREATE TABLE consent (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES eval_session (id),
  type         text NOT NULL CHECK (type IN ('verbal', 'signed')),
  captured_by  text NOT NULL,
  captured_at  timestamptz NOT NULL
);

CREATE TABLE recording (
  session_id        uuid PRIMARY KEY REFERENCES eval_session (id),
  audio_uri         text,                       -- encrypted object; NULL once deleted
  duration_ms       int NOT NULL,
  retention_policy  jsonb NOT NULL,
  delete_after      timestamptz,
  deleted_at        timestamptz
);

CREATE TABLE transcript (
  session_id  uuid PRIMARY KEY REFERENCES eval_session (id),
  segments    jsonb NOT NULL                     -- [{speaker, startMs, endMs, text}]
);

-- ------------------------------------------------------- reviewable content
CREATE TABLE finding (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES eval_session (id),
  field_key    text NOT NULL,                    -- template-independent clinical key
  value        jsonb NOT NULL,
  source_span  jsonb,
  confidence   real CHECK (confidence BETWEEN 0 AND 1),
  origin       text NOT NULL CHECK (origin IN ('ai', 'clinician')),
  status       text NOT NULL CHECK (status IN ('pending', 'confirmed', 'edited', 'rejected')),
  flags        jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (origin = 'clinician' OR source_span IS NOT NULL)   -- AI items always carry provenance
);
CREATE INDEX finding_session ON finding (session_id);

CREATE TABLE measurement (
  id              uuid PRIMARY KEY,
  session_id      uuid NOT NULL REFERENCES eval_session (id),
  measure_type_id text NOT NULL REFERENCES measure_type (id),
  body_region     text,
  joint           text,
  side            text CHECK (side IN ('left', 'right', 'bilateral')),
  motion          text,
  mode            text CHECK (mode IN ('active', 'passive')),
  value           jsonb NOT NULL,
  unit            text,
  notes           text,
  source_span     jsonb,
  confidence      real CHECK (confidence BETWEEN 0 AND 1),
  origin          text NOT NULL CHECK (origin IN ('ai', 'clinician')),
  status          text NOT NULL CHECK (status IN ('pending', 'confirmed', 'edited', 'rejected')),
  flags           jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (origin = 'clinician' OR source_span IS NOT NULL)
);
CREATE INDEX measurement_session ON measurement (session_id);

CREATE TABLE goal (
  id                 uuid PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES eval_session (id),
  term               text NOT NULL CHECK (term IN ('short', 'long')),
  text               text NOT NULL,
  baseline_finding_keys text[] NOT NULL DEFAULT '{}',
  target_value       jsonb,
  timeframe_weeks    int NOT NULL CHECK (timeframe_weeks > 0),
  functional_outcome text,
  origin             text NOT NULL CHECK (origin IN ('ai', 'clinician')),
  status             text NOT NULL CHECK (status IN ('pending', 'confirmed', 'edited', 'rejected'))
);

-- A goal can have several baselines (PRD table had a single id).
CREATE TABLE goal_baseline (
  goal_id         uuid NOT NULL REFERENCES goal (id) ON DELETE CASCADE,
  measurement_id  uuid NOT NULL REFERENCES measurement (id),
  PRIMARY KEY (goal_id, measurement_id)
);

CREATE TABLE audit_event (
  id          uuid PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES eval_session (id),
  actor       text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL
);
CREATE INDEX audit_event_session ON audit_event (session_id, at);

-- ----------------------------------------------------------------- guards
-- No consent, no recording (FR-REC-2), enforced in the database too.
CREATE FUNCTION require_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consent WHERE session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'consent required before recording (session %)', NEW.session_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recording_requires_consent BEFORE INSERT ON recording
  FOR EACH ROW EXECUTE FUNCTION require_consent();

-- Signed sessions are immutable (addenda are a separate, future flow).
CREATE FUNCTION forbid_signed_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid := COALESCE(NEW.session_id, OLD.session_id);
BEGIN
  IF EXISTS (SELECT 1 FROM eval_session WHERE id = sid AND status = 'signed') THEN
    RAISE EXCEPTION 'session % is signed and locked', sid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER finding_locked     BEFORE INSERT OR UPDATE OR DELETE ON finding     FOR EACH ROW EXECUTE FUNCTION forbid_signed_changes();
CREATE TRIGGER measurement_locked BEFORE INSERT OR UPDATE OR DELETE ON measurement FOR EACH ROW EXECUTE FUNCTION forbid_signed_changes();
CREATE TRIGGER goal_locked        BEFORE INSERT OR UPDATE OR DELETE ON goal        FOR EACH ROW EXECUTE FUNCTION forbid_signed_changes();

-- Audit is append-only.
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
