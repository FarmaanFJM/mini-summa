// Report protocol: the LAST non-empty line of the final assistant message must be
//   <!-- mini-summa:report status=complete|partial|blocked task="Short title" -->
// The marker is a declaration by Claude. It is not evidence that anything worked.
const MARKER_RE = /^<!-- mini-summa:report status=(complete|partial|blocked) task="([^"\r\n]{1,200})" -->$/;
const LOOSE_RE = /mini-summa:report/i;

export function parseMarker(message) {
  if (typeof message !== 'string' || message.length === 0) {
    return { valid: false, reason: 'missing_or_empty_message' };
  }
  const lines = message.split(/\r?\n/);
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return { valid: false, reason: 'blank_message' };
  const last = lines[i].trim();
  const m = MARKER_RE.exec(last);
  const hasHeading = /^##\s+Implementation Report\b/m.test(message);
  if (m) {
    return { valid: true, status: m[1], task: m[2], has_heading: hasHeading, marker_line: i + 1 };
  }
  // Marker-like text that is not a valid final line is surfaced, never trusted.
  if (LOOSE_RE.test(message)) return { valid: false, reason: 'malformed_or_misplaced_marker' };
  return { valid: false, reason: 'no_marker' };
}
