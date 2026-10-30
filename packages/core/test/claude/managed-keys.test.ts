import { describe, expect, it } from 'vitest';
import {
  BRACKETED_PASTE_END, BRACKETED_PASTE_START, ENTER, ESCAPE, PERMISSION_KEYS, SUBMIT_DELAY_MS, encodeUserText, sanitizeUserText,
} from '../../src/claude/keys.ts';

describe('keys: answering the permission dialog', () => {
  it('has one table: approve is Enter, reject is Escape', () => {
    expect(PERMISSION_KEYS).toEqual({ approve: '\r', reject: '\x1b' });
    expect(PERMISSION_KEYS.approve).toBe(ENTER);
    expect(PERMISSION_KEYS.reject).toBe(ESCAPE);
  });
});

describe('encodeUserText', () => {
  it('single line without submit: the text only, left in the input box', () => {
    expect(encodeUserText('fix the login bug', { submit: false })).toEqual([{ data: 'fix the login bug', delayMs: 0 }]);
  });

  it('single line with submit: the text, then Enter as its own later write', () => {
    expect(encodeUserText('fix the login bug', { submit: true })).toEqual([
      { data: 'fix the login bug', delayMs: 0 },
      { data: '\r', delayMs: SUBMIT_DELAY_MS },
    ]);
  });

  it('several lines: ONE bracketed paste, so the line breaks stay inside a single prompt', () => {
    expect(encodeUserText('first\nsecond\nthird', { submit: true, submitDelayMs: 40 })).toEqual([
      { data: `${BRACKETED_PASTE_START}first\nsecond\nthird${BRACKETED_PASTE_END}`, delayMs: 0 },
      { data: '\r', delayMs: 40 },
    ]);
    expect(BRACKETED_PASTE_START).toBe('\x1b[200~');
    expect(BRACKETED_PASTE_END).toBe('\x1b[201~');
  });

  it('several lines without submit: the paste only', () => {
    expect(encodeUserText('a\nb', { submit: false })).toEqual([{ data: '\x1b[200~a\nb\x1b[201~', delayMs: 0 }]);
  });

  it('turns CRLF and lone CR into newlines before deciding single or multi line', () => {
    expect(encodeUserText('a\r\nb\rc', { submit: false })[0].data).toBe('\x1b[200~a\nb\nc\x1b[201~');
  });

  it('pastes text with a tab, because a typed Tab key is a command in the input box', () => {
    expect(encodeUserText('a\tb', { submit: false })[0].data).toBe('\x1b[200~a\tb\x1b[201~');
  });

  it('keeps unicode and leading/trailing spaces exactly', () => {
    expect(encodeUserText('  grüße 日本語 🚀  ', { submit: false })).toEqual([{ data: '  grüße 日本語 🚀  ', delayMs: 0 }]);
  });

  it('empty text: nothing to type; with submit just Enter, without a pointless delay', () => {
    expect(encodeUserText('', { submit: false })).toEqual([]);
    expect(encodeUserText('', { submit: true })).toEqual([{ data: '\r', delayMs: 0 }]);
  });

  it('cannot be used to leave the paste: control characters, including the ESC of an end-of-paste marker, are removed', () => {
    const hostile = 'harmless\x1b[201~\rrm -rf ~\r\x03\x7f\x07';
    const [step] = encodeUserText(hostile, { submit: false });
    // the carriage returns became newlines, so this is a (safe) bracketed paste whose only ESCs are the two markers
    expect(step.data.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(step.data.endsWith(BRACKETED_PASTE_END)).toBe(true);
    const inner = step.data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    expect(inner).toBe('harmless[201~\nrm -rf ~\n');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(inner)).toBe(false);
  });

  it('sanitizeUserText drops C0, DEL and C1 controls but keeps newline and tab', () => {
    expect(sanitizeUserText('a\u0000b\u001bc\u009bd\u0085e\nf\tg')).toBe('abcde\nf\tg');
  });
});
