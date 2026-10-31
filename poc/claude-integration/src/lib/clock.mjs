import fs from 'node:fs';

// A monotonic timestamp is only meaningful relative to another from the SAME clock domain: one machine, one boot.
// Across a reboot the counter restarts. Native Windows and WSL2 are different environments and are never compared.
//
// A domain is known only when it can be identified exactly. Linux (including every WSL distribution) exposes a boot
// id. Native Windows and macOS expose none here, so their domain is null, and monotonic comparison is unavailable
// there: ordering must then come from snapshot intervals or other evidence, never from a clock we cannot vouch for.
export function bootKey(platform = process.platform, read = (p) => fs.readFileSync(p, 'utf8')) {
  if (platform !== 'linux') return null;
  try { return read('/proc/sys/kernel/random/boot_id').trim() || null; } catch { return null; }
}

export function clockDomain(envId, platform = process.platform, read) {
  const b = bootKey(platform, read);
  return b ? `${envId}|boot:${b}` : null;
}

export function markerOf(transport = {}) {
  return { tid: transport.transport_id ?? null, env: transport.env_id ?? 'local', domain: transport.clock_domain ?? null,
    mono: transport.monotonic_ns ?? null };
}

// Relation of `b` to `a`: 'after' | 'before' | 'uncertain'. 'uncertain' is an answer, not an error: it means the
// documented inputs do not establish an order, and callers must not invent one.
export function compareMarkers(a, b) {
  if (!a || !b) return 'uncertain';
  if (a.env !== b.env) return 'uncertain';
  if (!a.domain || a.domain !== b.domain) return 'uncertain';
  if (a.mono == null || b.mono == null) return 'uncertain';
  const x = BigInt(a.mono); const y = BigInt(b.mono);
  return y > x ? 'after' : y < x ? 'before' : 'uncertain';
}
