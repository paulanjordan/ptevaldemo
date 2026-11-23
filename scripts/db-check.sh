#!/usr/bin/env bash
# Spin up a throwaway Postgres 16 cluster, apply migrations, seed registries,
# and exercise the database guards. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=$(mktemp -d)
PORT=${PGPORT_CHECK:-54329}
SOCK=$(mktemp -d)
RUN=""
if [ "$(id -u)" = "0" ]; then chown postgres "$DATA" "$SOCK"; RUN="runuser -u postgres --"; fi
cleanup() { $RUN "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DATA" "$SOCK"; }
trap cleanup EXIT

$RUN "$PGBIN/initdb" -D "$DATA" -A trust -U postgres >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w start >/dev/null
PSQL="psql -h $SOCK -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"

for f in db/migrations/*.sql; do echo "apply $f"; $PSQL -f "$f"; done
npx tsx scripts/seed-sql.ts | $PSQL
echo "seeded: $($PSQL -tA -c 'select count(*) from eval_assistant.measure_type') measure types, $($PSQL -tA -c 'select count(*) from eval_assistant.template') templates"

expect_fail() { # $1 = description, $2 = sql
  if $PSQL -c "$2" >/dev/null 2>&1; then echo "FAIL: $1 was allowed"; exit 1; else echo "ok: $1 rejected"; fi
}
S=00000000-0000-0000-0000-000000000001
$PSQL <<SQL
SET search_path TO eval_assistant;
INSERT INTO eval_session VALUES ('$S','pat-1','appt-1','enc-1','pt-1','pt','pt.knee',1,'draft','{}',now(),NULL);
SQL
expect_fail "recording without consent" "INSERT INTO eval_assistant.recording (session_id, duration_ms, retention_policy) VALUES ('$S', 1000, '{}')"
expect_fail "AI finding without provenance" "INSERT INTO eval_assistant.finding (id, session_id, field_key, value, confidence, origin, status) VALUES (gen_random_uuid(), '$S', 'pain.worst', '8', 0.9, 'ai', 'pending')"
expect_fail "second open draft for one appointment" "INSERT INTO eval_assistant.eval_session VALUES (gen_random_uuid(),'pat-1','appt-1','enc-1','pt-1','pt','pt.knee',1,'draft','{}',now(),NULL)"
$PSQL <<SQL
SET search_path TO eval_assistant;
INSERT INTO consent VALUES (gen_random_uuid(), '$S', 'verbal', 'pt-1', now());
INSERT INTO recording (session_id, audio_uri, duration_ms, retention_policy) VALUES ('$S', 'audio://x', 1000, '{"kind":"delete_on_sign"}');
INSERT INTO measurement (id, session_id, measure_type_id, joint, side, motion, mode, value, unit, source_span, confidence, origin, status)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '$S', 'pt.rom', 'knee', 'right', 'flexion', 'active', '{"kind":"number","value":95}', 'deg', '{"segmentIndex":0,"start":0,"end":5,"text":"x"}', 0.95, 'ai', 'pending');
INSERT INTO goal VALUES ('00000000-0000-0000-0000-0000000000b1', '$S', 'long', 'Increase R knee flexion AROM from 95° to 120°', '{}', '{"kind":"number","value":120}', 8, 'stairs', 'ai', 'pending');
INSERT INTO goal_baseline VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1');
INSERT INTO audit_event VALUES (gen_random_uuid(), '$S', 'pt-1', 'session.signed', 'session', '$S', NULL, NULL, now());
UPDATE eval_session SET status = 'signed', signed_at = now() WHERE id = '$S';
SQL
echo "ok: consented session with measurement + goal baseline signed"
expect_fail "editing a signed session's measurement" "UPDATE eval_assistant.measurement SET value = '{\"kind\":\"number\",\"value\":100}' WHERE session_id = '$S'"
expect_fail "deleting audit history" "DELETE FROM eval_assistant.audit_event"
echo "db-check passed"
