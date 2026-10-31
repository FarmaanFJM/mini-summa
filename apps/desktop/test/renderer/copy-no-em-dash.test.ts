// P13 and CHK-017: no em dash (U+2014) in anything a person can read. Checked on the source of the renderer and of the main process,
// so no screen, dialog, notification, tooltip or aria-label can slip through. Comments may keep them; strings, markup text and CSS content may not.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP = path.resolve(__dirname, '../..');
const ROOTS = ['src/renderer', 'src/main', 'src/preload'].map((r) => path.join(DESKTOP, r));
const EXTENSIONS = /\.(tsx?|css|html)$/;

// Built from a character code so this file itself holds no dash that a search for dashes would find.
const EM_DASH = String.fromCharCode(0x2014);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'out' || e.name === 'dist') return [];
    return e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)];
  });
}

export interface Hit { line: number; text: string }

/**
 * Every line of `source` that has an em dash outside a comment. A small scanner, not a parser: it follows quotes and template
 * strings so that "//" inside a string (an address) is not taken for a comment, and it drops // and block comments, in code and in CSS.
 * Where it cannot tell (an apostrophe in JSX text), it errs on the side of reporting.
 */
export function emDashesOutsideComments(source: string): Hit[] {
  const hits: Hit[] = [];
  const lines = source.split('\n');
  let state: 'code' | 'block' | 'single' | 'double' | 'template' = 'code';
  lines.forEach((text, index) => {
    let found = false;
    // A quoted string cannot run past the end of its line; a block comment and a template string can.
    if (state === 'single' || state === 'double') state = 'code';
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      const next = text[i + 1];
      if (state === 'block') {
        if (c === '*' && next === '/') { state = 'code'; i += 1; }
        continue;
      }
      if (state === 'code') {
        if (c === '/' && next === '/') break; // the rest of the line is a comment
        if (c === '/' && next === '*') { state = 'block'; i += 1; continue; }
        if (c === "'") { state = 'single'; continue; }
        if (c === '"') { state = 'double'; continue; }
        if (c === '`') { state = 'template'; continue; }
      } else if (c === '\\') {
        i += 1; // an escaped character cannot end the string
        continue;
      } else if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
        state = 'code';
        continue;
      }
      if (c === EM_DASH) found = true;
    }
    if (found) hits.push({ line: index + 1, text: text.trim() });
  });
  return hits;
}

describe('the scanner', () => {
  const dash = (s: string) => emDashesOutsideComments(s).map((h) => h.line);

  it('reports a dash in a string, in a template, in JSX text and in CSS content', () => {
    expect(dash(`const a = 'one ${EM_DASH} two';`)).toEqual([1]);
    expect(dash(`const a = \`one ${EM_DASH} \${x}\`;`)).toEqual([1]);
    expect(dash(`const a = <p>one ${EM_DASH} two</p>;`)).toEqual([1]);
    expect(dash(`.x::after { content: "${EM_DASH}"; }`)).toEqual([1]);
    expect(dash(`label="${EM_DASH}"`)).toEqual([1]);
  });

  it('lets a comment keep one, on a line of its own, after code, or inside a block', () => {
    expect(dash(`// one ${EM_DASH} two`)).toEqual([]);
    expect(dash(`const a = 1; // one ${EM_DASH} two`)).toEqual([]);
    expect(dash(`/* one ${EM_DASH} two */`)).toEqual([]);
    expect(dash(`/**\n * one ${EM_DASH} two\n */\nconst a = 1;`)).toEqual([]);
    expect(dash(`.x { color: red; } /* one ${EM_DASH} two */`)).toEqual([]);
  });

  it('is not fooled by two slashes inside a string, and finds the dash that follows it', () => {
    expect(dash(`const a = 'https://example.com ${EM_DASH} x';`)).toEqual([1]);
    expect(dash(`const a = "http://x"; // ${EM_DASH}`)).toEqual([]);
  });

  it('reads on after a block comment, and after an escaped quote', () => {
    expect(dash(`/* a\n b */ const a = '${EM_DASH}';`)).toEqual([2]);
    expect(dash(`const a = 'it\\'s ${EM_DASH}';`)).toEqual([1]);
  });
});

describe('the shipped interface', () => {
  const files = ROOTS.flatMap(walk).filter((f) => EXTENSIONS.test(f));

  it('covers the renderer, the main process and the preload', () => {
    expect(files.some((f) => f.includes(`${path.sep}renderer${path.sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${path.sep}main${path.sep}`))).toBe(true);
    expect(files.length).toBeGreaterThan(150);
  });

  it('has no em dash in any string, markup text, tooltip, aria-label, dialog or notification (comments may)', () => {
    const offenders = files.flatMap((f) => emDashesOutsideComments(fs.readFileSync(f, 'utf8')).map((h) => `${path.relative(DESKTOP, f)}:${h.line}: ${h.text.slice(0, 120)}`));
    expect(offenders).toEqual([]);
  });
});
