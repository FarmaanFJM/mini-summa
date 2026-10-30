// Redaction applied by the hook BEFORE anything touches disk.
// Keys that look like credentials are replaced wholesale; string values are scanned for well-known token shapes and for
// secrets written the way people type them into commands and configuration (docs/CHANGES-FROM-POC.md, change 9). Counts are
// returned so the transport metadata can say how much was removed (never what).
//
// This is a deny-list: it hides what it recognises and nothing else, and it errs towards hiding (a placeholder such as
// `API_KEY=your-key` is hidden too). Every rule that keys on ordinary words (password, token, secret, Bearer, --flags) is
// written so that prose, identifiers and type annotations are left alone; test/redaction-patterns.test.mjs measures that on
// a list of look-alikes and on every fixture and example in the package.
const KEY_RE = /(token|secret|passw(or)?d|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const REDACTED = '[REDACTED]';

// ---- private keys -------------------------------------------------------------------------------------------------------
// A PEM private key block, with or without its END line. Looked for in a window of PEM_WINDOW characters after the header;
// without an END line what follows the header is taken as long as it still looks like base64, up to the same window.
const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_WINDOW = 4096;
const PEM_MIN_BODY = 8;  // without an END line, fewer base64 characters than this after the header is not a key
const PEM_BODY = /^[A-Za-z0-9+/=\s\\:,.-]*$/; // all that may stand between the header and the END line: base64, line breaks (also as \n), the Proc-Type/DEK-Info lines of old keys

function redactPem(s, counter) {
  if (!s.includes('-----BEGIN ')) return s;
  let out = ''; let from = 0; let m;
  PEM_BEGIN.lastIndex = 0;
  while ((m = PEM_BEGIN.exec(s)) !== null) {
    const bodyStart = m.index + m[0].length;
    const window = s.slice(bodyStart, bodyStart + PEM_WINDOW);
    let end = PEM_END.exec(window);
    if (end && !PEM_BODY.test(window.slice(0, end.index))) end = null; // code that builds a PEM string has more than base64 between the two lines
    let stop;
    if (end) stop = bodyStart + end.index + end[0].length;
    else {
      let run = /^[A-Za-z0-9+/=\\\r\n]*/.exec(window)[0]; // base64 lines, or the same with escaped newlines
      if (/^[ \t]/.test(window.slice(run.length))) run = run.slice(0, run.lastIndexOf('\n') + 1); // do not eat the first word of prose that follows
      if (run.replace(/[\s\\]/g, '').length < PEM_MIN_BODY) continue; // the header mentioned in prose, with no key after it: nothing to hide
      stop = bodyStart + run.length;
    }
    out += s.slice(from, m.index) + REDACTED;
    from = stop;
    counter.n++;
    PEM_BEGIN.lastIndex = stop;
  }
  return out + s.slice(from);
}

// ---- rules ----------------------------------------------------------------------------------------------------------------
// [pattern, replacer]. A null replacer hides the whole match. A replacer gets the replace() arguments and returns the new
// text, or null to leave this match alone (it was a look-alike). Each match that is hidden counts once.

// A value that is a reference to a variable ($TOKEN, "${TOKEN}") or that an earlier rule already hid is not a secret to hide.
const REFERENCE = '(?:"?\\$|["\']?\\[REDACTED\\])';
const REFERENCE_RE = new RegExp(`^${REFERENCE}`);
const unquote = (v) => v.replace(/^["']|["']$/g, '');
// the value of a flag: quoted, or up to the next space or quote (never across a backtick, which closes a code span in prose)
const FLAG_VALUE = '("[^"\\n]+"|\'[^\'\\n]+\'|[^\\s"\'`]+)';
// a name in capitals that ends in a secret word: DB_PASSWORD, GITHUB_TOKEN, API_KEY. MAX_TOKENS, TOKEN_LIMIT, PASSWORD_MIN_LENGTH do not.
const SECRET_NAME = /(?:^|_)(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|SECRET_?KEY|ACCESS_?KEY|PRIVATE_?KEY)$/;
// words that follow a mention of a flag in prose ("the --token flag"), which are not its value
const PROSE = new Set(['flag', 'option', 'argument', 'parameter', 'param', 'arg', 'value', 'is', 'are', 'was', 'must', 'should', 'can', 'will',
  'to', 'and', 'or', 'if', 'when', 'with', 'for', 'in', 'on', 'as', 'not', 'be', 'the', 'a', 'an', 'it', 'this', 'that', 'instead', 'here', 'set', 'from', 'file']);
const BEARER_PROSE = new Set(['tokens', 'scheme', 'schemes', 'header', 'headers', 'prefix', 'strategy', 'access', 'credential', 'credentials', 'values', 'protocol']);
// WWW-Authenticate: Bearer realm="api", error="invalid_token" is a challenge, not a credential
const BEARER_PARAM = /^(?:realm|error|error_description|error_uri|scope|resource_metadata|charset)=/i;
const isBearerProse = (v) => BEARER_PARAM.test(v) || BEARER_PROSE.has(v.replace(/[.,;:=~+/_-]+$/, '').toLowerCase());
const bare = (v) => v.replace(/^["']|["'.,;:!?)]+$/g, '').toLowerCase();
// usage text or an elision, not a value: `--token <token>`, `--password PASSWORD`, `PASSWORD=...`, `PASSWORD=****`
const isPlaceholder = (v) => {
  const core = unquote(v).replace(/[`,.;:!?)\]}]+$/, '');
  return /^<[^<>\s]+>$/.test(core) || /^(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API[_-]?KEY|KEY|VALUE|STRING)$/.test(core) || /^(?:\.{2,}|\u2026+|\*+)$/.test(unquote(v));
};

// The text of the command that a flag belongs to: its line, and the lines before it that end in a backslash. Looks back at most
// LOOKBACK characters, so a very long line cannot make the scan quadratic.
const LOOKBACK = 2000;
function commandBefore(str, offset) {
  const win = str.slice(Math.max(0, offset - LOOKBACK), offset);
  let start = win.lastIndexOf('\n') + 1;
  for (let i = 0; i < 20 && start > 0; i++) {
    let eol = start - 1;                                  // the newline that ends the previous line
    if (win[eol - 1] === '\r') eol--;
    if (win[eol - 1] !== '\\') break;                     // that line does not continue onto this one
    start = win.lastIndexOf('\n', eol - 1) + 1;
  }
  return win.slice(start);
}

const RULES = [
  // the original rules, in their original order
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, null],
  [/sk-[A-Za-z0-9]{20,}/g, null],
  // 12 or more characters, as before; 6 to 11 as well, unless it is a word that follows "Bearer" in a sentence ("Bearer tokens")
  [/\bBearer\s+([A-Za-z0-9._~+/=-]{6,})/g,
    (m, token) => (token.length < 12 && isBearerProse(token) ? null : REDACTED)],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, null],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, null],
  [/\bAKIA[0-9A-Z]{16}\b/g, null],

  // more token shapes, hidden wherever they appear
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}/g, null],                                   // OpenAI project, service-account and admin keys
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, null],                                       // Stripe secret and restricted keys
  [/\bglpat-[A-Za-z0-9_-]{8,}/g, null],                                                        // GitLab personal access tokens
  [/\b(?:xox[bpaers]|xapp)-[A-Za-z0-9-]{8,}/g, null],                                         // Slack tokens
  [/(?:https?:\/\/)?\bhooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g, null], // Slack incoming webhooks
  [/\bAIza[0-9A-Za-z_-]{20,}/g, null],                                                        // Google API keys
  [/\bnpm_[A-Za-z0-9]{16,}/g, null],                                                          // npm access tokens
  [/\bhf_[A-Za-z0-9]{16,}/g, null],                                                           // Hugging Face tokens

  // secrets in the way they are written: the name or the option stays, the value goes
  [/\b(aws_secret_access_key["']?(?:[ \t]*[=:][ \t]*|[ \t]+)["']?)([A-Za-z0-9/+=]{6,})/gi,
    (m, head, value) => (value.length >= 16 || /[0-9/+=]/.test(value) ? head + REDACTED : null)],
  // Authorization: Basic <base64>, and Authorization: Bearer <anything of 6 or more> (any case). Base64 is never one plain word.
  [/\b(Authorization["']?\s*[:=]\s*["']?(?:(Basic)|Bearer)\s+)([A-Za-z0-9+/=._~-]{6,})(?![A-Za-z0-9+/=._~(<{$-])/gi,
    (m, head, basic, value) => ((basic ? /^[A-Z]?[a-z]+$/.test(value) : isBearerProse(value)) ? null : head + REDACTED)],
  // curl -u user:password, curl -sSu user:password, curl --user user:password
  [/(\s)(-[A-Za-z]*u|--user)([ \t]+|=)("[^"\n]+"|'[^'\n]+'|[^\s"']+)/g, (m, space, flag, sep, credentials, offset, str) => {
    if (!/\bcurl\b/.test(commandBefore(str, offset))) return null;       // -u means other things for other programs
    const user = unquote(credentials);
    const colon = user.indexOf(':');
    if (colon < 0 || colon === user.length - 1) return null;                               // no password given: curl asks for it
    if (user.includes(REDACTED) || (credentials[0] !== "'" && user[colon + 1] === '$')) return null; // already hidden, or a $variable
    return space + flag + sep + REDACTED;
  }],
  // scheme://user:password@host
  [/\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)([^\s/?#@:"'<>]*):([^\s/?#@"'<>]+)@/g,
    (m, scheme, user, password) => (REFERENCE_RE.test(password) ? null : `${scheme}${REDACTED}@`)],
  [/\b(AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{6,})/gi, (m, name) => `${name}=${REDACTED}`],
  // --password=hunter2, --client-secret=hunter2 (any prefix before the secret word when there is an =) ...
  [new RegExp(`(?<![A-Za-z0-9-])(--(?:[a-z][a-z0-9]*-)*(?:password|passwd|token|secret|api-key)=)(?!${REFERENCE})${FLAG_VALUE}`, 'g'),
    (m, head, value) => (isPlaceholder(value) ? null : head + REDACTED)],
  // ... and --password hunter2 (only the five bare names, and not the next word of a sentence about the flag)
  [new RegExp(`(?<![A-Za-z0-9-])(--(?:password|passwd|token|secret|api-key)[ \\t]+)(?!-)(?!${REFERENCE})${FLAG_VALUE}`, 'g'),
    (m, head, value) => (PROSE.has(bare(value)) || isPlaceholder(value) ? null : head + REDACTED)],
  // KEY=VALUE where the name is a capitalised variable that ends in a secret word. The value is not empty, not a $variable,
  // not already hidden, and not a comparison (TOKEN==x) or a boolean.
  [/(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)=(?!=)("[^"\n]+"|'[^'\n]+'|[^\s"'`;|&<>()]+)/g,
    (m, name, value) => (SECRET_NAME.test(name) && !REFERENCE_RE.test(value) && !isPlaceholder(value) && !/^(?:true|false)$/i.test(unquote(value))
      ? `${name}=${REDACTED}` : null)],
];

export function redactString(s, counter) {
  let out = redactPem(s, counter);
  for (const [re, replacer] of RULES) {
    out = out.replace(re, (...args) => {
      const replacement = replacer ? replacer(...args) : REDACTED;
      if (replacement === null) return args[0];
      counter.n++;
      return replacement;
    });
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
