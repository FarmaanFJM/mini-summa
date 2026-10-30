// Splits a report body into prose and fenced code so code can be shown monospaced. The split is lossless: joining
// `raw` of every block gives back the original string byte for byte, so what is shown (and copied) is the full report.

export type Block =
  | { kind: 'text'; raw: string; text: string }
  | { kind: 'code'; raw: string; text: string; lang: string | null; closed: boolean };

function splitLines(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf('\n', i);
    if (j < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function splitFences(body: string): Block[] {
  const lines = splitLines(body);
  const blocks: Block[] = [];
  let prose = '';
  const flushProse = () => { if (prose) { blocks.push({ kind: 'text', raw: prose, text: prose }); prose = ''; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = OPEN.exec(line.replace(/\r?\n$/, ''));
    // A backtick fence's info string cannot contain a backtick; that is how inline code at line start is told apart.
    if (!m || (m[1][0] === '`' && m[2].includes('`'))) { prose += line; continue; }
    flushProse();
    const fence = m[1];
    const lang = m[2].trim() || null;
    let raw = line;
    let inner = '';
    let closed = false;
    let j = i + 1;
    const closeRe = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    for (; j < lines.length; j++) {
      const l = lines[j];
      raw += l;
      if (closeRe.test(l.replace(/\r?\n$/, ''))) { closed = true; break; }
      inner += l;
    }
    blocks.push({ kind: 'code', raw, text: inner.replace(/\r?\n$/, ''), lang, closed });
    i = closed ? j : lines.length;
  }
  flushProse();
  return blocks;
}

export interface DisplayItem {
  id: string;
  kind: 'text' | 'code';
  text: string;
  /** For code split across several items: lets the view join them visually. */
  first: boolean;
  last: boolean;
}

/** Break long blocks at line boundaries so a very long report never becomes one giant native text view. */
export function toDisplayItems(body: string, maxChars = 3000): DisplayItem[] {
  const items: DisplayItem[] = [];
  splitFences(body).forEach((b, bi) => {
    const parts = chunk(b.text, maxChars);
    parts.forEach((p, pi) => items.push({ id: `${bi}:${pi}`, kind: b.kind, text: p, first: pi === 0, last: pi === parts.length - 1 }));
  });
  return items;
}

function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of splitLines(text)) {
    if (line.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      for (let k = 0; k < line.length; k += max) out.push(line.slice(k, k + max));
      continue;
    }
    if (cur.length + line.length > max) { out.push(cur); cur = ''; }
    cur += line;
  }
  if (cur) out.push(cur);
  return out;
}
