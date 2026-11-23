/** Emit INSERTs for the PT registries so the DB mirrors the code config. */
import { ptLayer } from '../src/disciplines/pt/index.js';

const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v: unknown) => `${q(JSON.stringify(v))}::jsonb`;

const lines = ['SET search_path TO eval_assistant;'];
for (const mt of ptLayer.measureTypes) {
  lines.push(`INSERT INTO measure_type (id, discipline, name, value_kind, unit) VALUES (${q(mt.id)}, ${q(mt.discipline)}, ${q(mt.name)}, ${q(mt.valueKind)}, ${q(mt.unit)});`);
}
for (const t of ptLayer.templates) {
  lines.push(`INSERT INTO template (id, version, discipline, name, sections, suggest_for) VALUES (${q(t.id)}, ${t.version}, ${q(t.discipline)}, ${q(t.name)}, ${j(t.sections)}, ${j(t.suggestFor)});`);
}
console.log(lines.join('\n'));
