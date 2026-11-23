/** Small text utilities that keep character offsets intact for provenance. */

export interface Piece {
  text: string;
  start: number; // offset in the segment
  end: number;
}

/** Split into sentences on . ! ? ; followed by whitespace/end (keeps "14.2"). */
export function sentences(text: string): Piece[] {
  const out: Piece[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if ('.!?;'.includes(c) && (next === undefined || /\s/.test(next))) {
      push(out, text, s, i + 1);
      s = i + 1;
    }
  }
  push(out, text, s, text.length);
  return out;
}

/** Split a piece into clauses on commas, "and", "but". */
export function clauses(p: Piece): Piece[] {
  const out: Piece[] = [];
  const re = /,|\band\b|\bbut\b/gi;
  let s = 0;
  for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
    push(out, p.text, s, m.index, p.start);
    s = m.index + m[0].length;
  }
  push(out, p.text, s, p.text.length, p.start);
  return out;
}

function push(out: Piece[], text: string, s: number, e: number, base = 0): void {
  let a = s;
  let b = e;
  while (a < b && /[\s,]/.test(text[a]!)) a++;
  while (b > a && /[\s,.;!?]/.test(text[b - 1]!)) b--;
  if (b > a) out.push({ text: text.slice(a, b), start: base + a, end: base + b });
}

export interface Hit<T> {
  value: T;
  start: number; // offset within the piece
  end: number;
}

/** All matches of a vocabulary (regex → canonical value) in a string, in order. */
export function findAll<T>(text: string, vocab: Array<[RegExp, T]>): Hit<T>[] {
  const hits: Hit<T>[] = [];
  for (const [re, value] of vocab) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let m = g.exec(text); m; m = g.exec(text)) hits.push({ value, start: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // drop hits contained in an earlier, longer hit ("internal rotation" vs "rotation")
  const out: Hit<T>[] = [];
  for (const h of hits) if (!out.some((o) => h.start >= o.start && h.end <= o.end)) out.push(h);
  return out;
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
export function toNumber(s: string): number | null {
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return WORD_NUM[s.toLowerCase()] ?? null;
}
