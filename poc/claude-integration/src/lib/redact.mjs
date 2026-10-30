// Redaction applied by the hook BEFORE anything touches disk.
// Keys that look like credentials are replaced wholesale; string values are
// scanned for well-known token shapes. Counts are returned so the transport
// metadata can say how much was removed (never what).
const KEY_RE = /(token|secret|passw(or)?d|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const VALUE_RES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactString(s, counter) {
  let out = s;
  for (const re of VALUE_RES) {
    out = out.replace(re, () => { counter.n++; return '[REDACTED]'; });
  }
  return out;
}

export function redactDeep(value, counter = { n: 0 }) {
  if (typeof value === 'string') return redactString(value, counter);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Credentials are strings/objects; numeric or boolean values under names like context_tokens are not.
      if (KEY_RE.test(k) && typeof v !== 'number' && typeof v !== 'boolean') { counter.n++; out[k] = '[REDACTED]'; }
      else out[k] = redactDeep(v, counter);
    }
    return out;
  }
  return value;
}

// Cap very large strings inside tool_input / tool_response only.
// last_assistant_message and prompt are never truncated.
export function limitStrings(value, max, stats) {
  if (typeof value === 'string') {
    if (value.length > max) {
      stats.n++;
      stats.bytes_dropped += value.length - max;
      return value.slice(0, max) + `[truncated ${value.length - max} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => limitStrings(v, max, stats));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = limitStrings(v, max, stats);
    return out;
  }
  return value;
}
