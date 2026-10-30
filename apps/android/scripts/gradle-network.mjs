// Reads Gradle's console output for failed downloads and says, in plain words, which download server refused what.
// Used by build-apk.mjs; it has no side effects, so scripts/gradle-network.test.mjs can test it on real Gradle output.

// Which download servers are which, so a refusal can be named ("Maven Central answered 429") and not just quoted.
const REGISTRIES = [
  [['repo.maven.apache.org', 'repo1.maven.org'], 'Maven Central'],
  [['dl.google.com', 'maven.google.com'], 'Google Maven'],
  [['plugins.gradle.org', 'plugins-artifacts.gradle.org'], 'Gradle Plugin Portal'],
  [['www.jitpack.io', 'jitpack.io'], 'JitPack'],
  [['services.gradle.org', 'downloads.gradle.org'], 'Gradle distribution'],
];
const STATUS_TEXT = { 408: 'Request Timeout', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** Names the server and the kind of file behind a download URL. */
export function describeUrl(url) {
  const u = new URL(url);
  const registry = REGISTRIES.find(([hosts]) => hosts.includes(u.hostname))?.[1] ?? u.hostname;
  const file = u.pathname.replace(/^.*\/maven2\//, '').replace(/^\//, '');
  const kind = /\.(pom|module|xml)$/.test(u.pathname) ? 'metadata' : 'library';
  return { registry, host: u.hostname, file, kind };
}

export function newEvidence() {
  return { refused: new Map(), network: new Set(), tls: false };
}

/** Looks at one line of Gradle output and remembers a refused or dropped download. */
export function scanLine(line, evidence) {
  const refused = /Could not (?:GET|HEAD) '(https?:\/\/[^']+)'\. Received status code (\d{3}) from server/.exec(line);
  if (refused) {
    evidence.refused.set(`${refused[2]} ${refused[1]}`, { status: Number(refused[2]), url: refused[1] });
    return;
  }
  if (/(?:Connect to \S+ failed|connect timed out|Read timed out|Connection reset|Connection refused|UnknownHostException|Remote host terminated|Premature end of Content-Length)/i.test(line)) {
    evidence.network.add(line.trim().slice(0, 220));
  }
  if (/PKIX path building failed|unable to find valid certification path/.test(line)) evidence.tls = true;
}

/** Transient = the server refused for now (408, 429, 5xx) or the connection dropped. A 401, 403 or 404, or a compile error, is not. */
export function isTransient(evidence) {
  return evidence.network.size > 0 || [...evidence.refused.values()].some((r) => r.status === 408 || r.status === 429 || r.status >= 500);
}

/** The message printed when Gradle failed on a download: which servers, which HTTP status, which files, and what to do. */
export function explainDownloadFailure(evidence) {
  const groups = new Map();
  for (const { status, url } of evidence.refused.values()) {
    const d = describeUrl(url);
    const key = `${status}|${d.registry}`;
    const g = groups.get(key) ?? { status, registry: d.registry, host: d.host, files: [] };
    g.files.push(d);
    groups.set(key, g);
  }
  const lines = ['', 'Gradle could not download these files:'];
  for (const g of groups.values()) {
    const libs = g.files.filter((f) => f.kind === 'library').length;
    const meta = g.files.length - libs;
    lines.push(`  HTTP ${g.status} ${STATUS_TEXT[g.status] ?? ''}`.trimEnd() + ` from ${g.registry} (${g.host}): ${g.files.length} file(s), ${libs} library, ${meta} metadata`);
    for (const f of g.files.slice(0, 5)) lines.push(`      ${f.file}`);
    if (g.files.length > 5) lines.push(`      ... and ${g.files.length - 5} more`);
  }
  if (evidence.network.size) {
    lines.push(`  Connection problems (${evidence.network.size} distinct), for example:`);
    for (const n of [...evidence.network].slice(0, 3)) lines.push(`      ${n}`);
  }
  if (evidence.tls) {
    lines.push('  A TLS certificate was not trusted (PKIX). If your network inspects HTTPS, give Java the certificate it uses (a truststore); do not turn verification off.');
  }
  if ([...evidence.refused.values()].some((r) => r.status === 429)) {
    lines.push('', 'HTTP 429 means the download server is throttling your network address (common on shared or cloud addresses). It is not a problem in',
      'the app or the build, and nothing is being skipped or weakened. Gradle keeps every file it already has, so running the same command again',
      'continues where it stopped. If it keeps happening: run it again later, build from another network (home or office), or send Gradle',
      'through a Maven mirror you trust with an init script in ~/.gradle/init.d/ (docs/ANDROID.md, "Build notes").');
  }
  return lines.join('\n');
}
