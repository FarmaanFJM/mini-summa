// Validation for everything that crosses from the renderer into the main process. Pure functions: no Electron imports.
//
// The renderer is trusted only as far as it is the core's own page. Even so, every argument is checked for type, size
// and shape before it reaches a native API, and the sender is checked on every call.
import path from 'node:path';
import { classifyClaudeNavigation, parseChatGptUrl, parseClaudeCodeUrl } from '@minisumma/shared';
import type { Rect } from '@minisumma/shared';
import { isUsableRect } from './bounds.ts';

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const bad = (what: string): never => { throw new ValidationError(`Invalid ${what}.`); };

// ---------------------------------------------------------------------------------------------------------------
// Sender

export interface SenderInfo {
  /** URL of the frame that sent the message; null when the frame is gone. */
  frameUrl: string | null | undefined;
  /** True when the frame is the top frame of its web contents. */
  isTopFrame: boolean;
  /** Id of the web contents that sent the message. */
  contentsId: number;
}

export const originOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin !== 'null' ? u.origin : null;
  } catch { return null; }
};

/** Only the main window's top frame, on the core's origin, may call into the main process. */
export function isTrustedSender(sender: SenderInfo, coreOrigin: string, mainContentsId: number | null): boolean {
  if (mainContentsId === null || sender.contentsId !== mainContentsId) return false;
  if (!sender.isTopFrame) return false;
  const origin = originOf(sender.frameUrl);
  return origin !== null && origin === coreOrigin;
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

export function validateBounds(value: unknown): Rect | null {
  if (value === null) return null;
  if (!isUsableRect(value)) return bad('bounds');
  const { x, y, width, height } = value;
  return { x, y, width, height };
}

export function validateBoolean(value: unknown, what: string): boolean {
  return typeof value === 'boolean' ? value : bad(what);
}

/** Addresses the renderer may load in the ChatGPT view: chatgpt.com over https, normalized. */
export function validateChatGptUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return bad('ChatGPT address');
  const parsed = parseChatGptUrl(value);
  return parsed.ok ? parsed.info.url : bad('ChatGPT address');
}

/** The longest address the renderer may ask a native view to load. */
export const MAX_PAGE_URL_LENGTH = 2048;

/**
 * Addresses the renderer may load in the Claude Code on the web view: https on claude.ai, under /code, and nothing else. Returns the
 * address to load: scheme, host and path normalized by parseClaudeCodeUrl, the QUERY KEPT (the documented way to preselect a repository
 * is ?repositories=owner/repo, and a prefilled prompt travels the same way) and the fragment dropped.
 *
 * It does not guess a missing scheme, as the shared helper does for text a person typed: the renderer always holds a full address, and
 * anything else is a mistake that should show up as an error and not be quietly repaired. An address that could be read two ways (a
 * backslash, control characters, spaces) is refused outright, the same refusal the view applies to links inside the page.
 */
export function validateClaudeWebUrl(value: unknown): string {
  const refuse = (): never => { throw new ValidationError('Invalid Claude Code address. Only https addresses on claude.ai/code can be shown in this view.'); };
  if (typeof value !== 'string') return refuse();
  const raw = value.trim();
  if (raw === '' || raw.length > MAX_PAGE_URL_LENGTH) return refuse();
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(raw)) return refuse();
  if (!/^https:\/\//i.test(raw)) return refuse();
  const parsed = parseClaudeCodeUrl(raw);
  if (!parsed.ok) return refuse();
  let search: string;
  try { search = new URL(raw).search; } catch { return refuse(); }
  const url = `${parsed.info.url}${search}`;
  return classifyClaudeNavigation(url) === 'claude' ? url : refuse();
}

/** https only, no credentials, no whitespace or control characters. Returns the normalized href. */
export function validateExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return bad('link');
  if (/[\u0000- \u007f]/.test(value)) return bad('link');
  let u: URL;
  try { u = new URL(value); } catch { return bad('link'); }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return bad('link');
  return u.href;
}

export const isExternalUrl = (value: unknown): boolean => {
  try { validateExternalUrl(value); return true; } catch { return false; }
};

const MAX_CLIPBOARD_CHARS = 5_000_000;

export function validateClipboardText(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_CLIPBOARD_CHARS ? value : bad('clipboard text');
}

const noNul = (s: string): boolean => !s.includes('\0');

export function validateDirectoryOptions(value: unknown): { title?: string; defaultPath?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return bad('dialog options');
  const { title, defaultPath } = value as Record<string, unknown>;
  const out: { title?: string; defaultPath?: string } = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || title.length > 200 || !noNul(title)) return bad('dialog title');
    out.title = title;
  }
  if (defaultPath !== undefined) {
    if (typeof defaultPath !== 'string' || defaultPath.length > 1024 || !noNul(defaultPath)) return bad('dialog path');
    out.defaultPath = defaultPath;
  }
  return out;
}

export function validateAbsolutePath(value: unknown, isAbsolute: (p: string) => boolean = path.isAbsolute): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !noNul(value) || !isAbsolute(value)) return bad('path');
  return value;
}

export function validateBadgeCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99_999 ? value : bad('badge count');
}
