// The browser tests must never be able to reach the real ChatGPT. These checks keep the pieces of that guarantee honest:
// the resolver rules, the canary that proves they are in force, and the rule that every script which starts a browser
// goes through that canary before it opens any ChatGPT address.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANARY_EXPECTED, CANARY_URL, OTHER_SITE_HOST, STAND_IN_HOSTS, STAND_IN_NAMES, hostResolverRules, isolationFailure,
} from './isolation.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');
const scripts = readdirSync(dir).filter((f) => f.endsWith('.mjs'));

describe('resolver rules', () => {
  it('map exactly the stand-in names to the local server, make every other name unresolvable, and leave loopback alone', () => {
    expect(hostResolverRules(4321).split(', ')).toEqual([
      'MAP chatgpt.com 127.0.0.1:4321', 'MAP www.chatgpt.com 127.0.0.1:4321', 'MAP chat.openai.com 127.0.0.1:4321',
      `MAP ${OTHER_SITE_HOST} 127.0.0.1:4321`, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost',
    ]);
  });

  it('only ever name the three ChatGPT addresses plus one unrelated site', () => {
    expect(STAND_IN_HOSTS).toEqual(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
    expect(STAND_IN_NAMES).toEqual([...STAND_IN_HOSTS, OTHER_SITE_HOST]);
    expect(OTHER_SITE_HOST).toMatch(/\.example$/); // a reserved name that can never be a real site
  });
});

describe('the canary', () => {
  it('is a public name that is not a ChatGPT name', () => {
    const host = new URL(CANARY_URL).hostname;
    expect(STAND_IN_NAMES).not.toContain(host);
    expect(host).not.toMatch(/chatgpt|openai/);
  });

  it('accepts only a name resolution failure as proof that the rules are in force', () => {
    for (const proof of ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/', 'net::ERR_NAME_NOT_RESOLVED']) expect(CANARY_EXPECTED.test(proof), proof).toBe(true);
    for (const other of ['loaded', '', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CERT_AUTHORITY_INVALID', 'Timeout 20000ms exceeded', 'net::ERR_NAME_RESOLUTION_FAILED', 'undefined']) {
      expect(CANARY_EXPECTED.test(other), other).toBe(false);
    }
  });

  it('stops with a message that says so', () => {
    const error = isolationFailure('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://example.com/\nCall log: ...');
    expect(error.message).toMatch(/NETWORK ISOLATION IS NOT IN FORCE/);
    expect(error.message).toMatch(/Stopping before any ChatGPT address is used/);
    expect(error.message).not.toContain('Call log');
  });
});

describe('every script that starts a browser', () => {
  const starters = scripts.filter((f) => /launchPersistentContext\(|chromium\.launch\(|spawn\(chromePath/.test(read(f)));

  it('is one of exactly two: the shared launcher and the DevTools keep-alive script', () => {
    expect(starters.sort()).toEqual(['keepalive.mjs', 'support.mjs']);
  });

  it('passes the resolver rules and no proxy, and proves the isolation before it hands the browser out', () => {
    const support = read('support.mjs');
    expect(support).toContain('`--host-resolver-rules=${rules}`');
    expect(support).toContain("'--no-proxy-server'");
    expect(support).toMatch(/await assertNetworkIsolated\(context, standIn\);\s*\} catch \(error\) \{\s*await context\.close\(\)[^\n]*\n\s*throw error;\s*\}\s*return context;/);
    const proof = support.slice(support.indexOf('export async function assertNetworkIsolated'), support.indexOf('/** Start Chromium'));
    const navigatesCanary = proof.indexOf('canary.goto(CANARY_URL');
    const stopsOnDoubt = proof.indexOf('if (!CANARY_EXPECTED.test(outcome)) throw isolationFailure(outcome);');
    const firstChatGptName = proof.indexOf('/__stand-in-check');
    expect(navigatesCanary).toBeGreaterThan(-1);
    expect(stopsOnDoubt).toBeGreaterThan(navigatesCanary); // the canary result decides ...
    expect(firstChatGptName).toBeGreaterThan(stopsOnDoubt); // ... before any ChatGPT name is tried
  });

  it('keepalive.mjs runs the canary before it looks at anything else, and never opens a ChatGPT address', () => {
    const keepalive = read('keepalive.mjs');
    expect(keepalive).toContain("'--no-proxy-server'");
    expect(keepalive).toContain('--host-resolver-rules=');
    expect(keepalive.indexOf('CANARY_EXPECTED.test')).toBeGreaterThan(-1);
    expect(keepalive.indexOf('CANARY_EXPECTED.test')).toBeLessThan(keepalive.indexOf('const workerTarget'));
    expect(keepalive).not.toMatch(/chatgpt\.com|chat\.openai\.com|convUrl/);
  });

  it('the other browser scripts only start a browser through launchBrowser', () => {
    for (const file of ['real-browser.mjs', 'with-real-core.mjs']) {
      const text = read(file);
      expect(text, file).toContain('launchBrowser(');
      expect(text, file).not.toMatch(/launchPersistentContext\(|chromium\.launch\(|spawn\(chromePath/);
      expect(text, file).not.toMatch(/\b(page|context)\.route\(/); // request interception does not cover tabs the browser opens itself
    }
  });
});
