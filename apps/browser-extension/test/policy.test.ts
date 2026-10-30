// Checks that turn the extension's promises into failing tests: what the manifest may ask for, which Chrome APIs the
// code may call, and that nothing in the repository folder uses an em dash. If one of these fails, the change needs a
// deliberate decision, not a quick edit of the test.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TEST_HOST_PERMISSIONS, transformManifest } from '../build.mjs';
import type { ExtensionManifest } from '../build.mjs';
import { EM_DASH } from './em-dash.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as ExtensionManifest;

describe('manifest.json', () => {
  it('is MV3 with exactly the three permissions and four host patterns that were agreed', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['tabs', 'storage', 'alarms']);
    expect(manifest.host_permissions).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  });

  it('declares no content scripts, no scripting, no activeTab, no all-urls access and nothing else that reaches into pages', () => {
    const forbiddenKeys = [
      'content_scripts', 'optional_permissions', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources',
      'declarative_net_request', 'devtools_page', 'chrome_url_overrides', 'commands', 'omnibox', 'side_panel', 'sandbox', 'user_scripts',
    ];
    for (const key of forbiddenKeys) expect(manifest, key).not.toHaveProperty(key);
    const text = JSON.stringify(manifest);
    for (const needle of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', '"scripting"', '"activeTab"', '"webRequest"', '"webNavigation"', '"debugger"', '"cookies"', '"history"', '"downloads"', '"nativeMessaging"', '"management"', '"declarativeNetRequest"']) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it('has a service worker, an options page and a description within the store limit', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    expect((manifest.description ?? '').length).toBeLessThanOrEqual(132);
    expect(manifest.version).toBe((JSON.parse(read('package.json')) as { version: string }).version);
    expect(manifest.icons).toEqual({ 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' });
  });

  it('limits where the extension pages and the worker may connect to this computer', () => {
    const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...sources] = d.split(/\s+/); return [name, sources]; }));
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'", 'http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*']);
  });
});

describe('the test build variant', () => {
  it('leaves the production manifest untouched', () => {
    expect(transformManifest(manifest)).toEqual(manifest);
    expect(transformManifest(manifest, { testHosts: false })).toEqual(manifest);
  });

  it('is labelled as a test build, allows the loopback patterns, and changes nothing else', () => {
    const test = transformManifest(manifest, { testHosts: true });
    expect(test.name).toBe('Mini-Summa tab focus (test build)');
    expect(test.version_name).toBe('0.1.0 test-hosts');
    expect(test.host_permissions).toEqual(expect.arrayContaining(TEST_HOST_PERMISSIONS));
    expect(test.host_permissions).toEqual(manifest.host_permissions); // the loopback patterns are already part of the production set
    expect(test.permissions).toEqual(manifest.permissions);
    const { name: _n, version_name: _v, ...rest } = test;
    const { name: _n2, ...baseRest } = manifest;
    expect(rest).toEqual(baseRest);
  });
});

// ---------------------------------------------------------------------------------------------------------------

function sourceFiles(): string[] {
  return readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts')).map((f) => path.join('src', f));
}

/** Every `chrome.<namespace>.<member>` property access in the code (comments, strings and types are not code). */
function chromeApisUsed(file: string): Set<string> {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'chrome') {
      found.add(`${node.expression.name.text}.${node.name.text}`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'chrome') {
      found.add(`${node.name.text}`); // a bare namespace such as `chrome.runtime` that is passed around
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('Chrome APIs used by the code', () => {
  const documented = (): string[] => {
    const header = read('src', 'bridge.ts').split('*/')[0];
    return [...header.matchAll(/^ \*   (chrome\.(?:tabs|windows)\.\w+)/gm)].map((m) => m[1]).sort();
  };

  it('tabs and windows are used only in bridge.ts and only as the header comment of bridge.ts lists them', () => {
    const used = new Map<string, string[]>();
    for (const file of sourceFiles()) {
      for (const api of chromeApisUsed(file)) {
        if (!/^(tabs|windows)\./.test(api)) continue;
        used.set(`chrome.${api}`, [...(used.get(`chrome.${api}`) ?? []), path.basename(file)]);
      }
    }
    expect([...used.keys()].sort()).toEqual(documented());
    expect(documented()).toEqual(['chrome.tabs.create', 'chrome.tabs.get', 'chrome.tabs.query', 'chrome.tabs.update', 'chrome.windows.update']);
    for (const files of used.values()) expect(files).toEqual(['bridge.ts']);
  });

  it('the complete set of chrome.* members used anywhere is this list and nothing else', () => {
    const all = new Set<string>();
    for (const file of sourceFiles()) for (const api of chromeApisUsed(file)) if (api.includes('.')) all.add(api);
    expect([...all].sort()).toEqual([
      'action.onClicked',
      'alarms.clear', 'alarms.create', 'alarms.get', 'alarms.onAlarm',
      'runtime.id', 'runtime.onMessage', 'runtime.openOptionsPage', 'runtime.sendMessage',
      'storage.local', 'storage.onChanged',
      'tabs.create', 'tabs.get', 'tabs.query', 'tabs.update',
      'windows.update',
    ]);
  });

  it('every API namespace that needs a permission has it in the manifest', () => {
    const namespaces = new Set<string>();
    for (const file of sourceFiles()) for (const api of chromeApisUsed(file)) if (api.includes('.')) namespaces.add(api.split('.')[0]);
    for (const ns of ['storage', 'alarms', 'tabs']) {
      expect(namespaces.has(ns), `${ns} is used`).toBe(true);
      expect(manifest.permissions, ns).toContain(ns);
    }
  });

  it('contains nothing that injects code, reads page content or loads remote code', () => {
    const banned = new Set(['scripting', 'executeScript', 'insertCSS', 'eval', 'importScripts', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'webNavigation', 'webRequest', 'debugger', 'cookies', 'captureVisibleTab', 'sendMessage_tabs']);
    for (const file of sourceFiles()) {
      const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
      const hits: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && banned.has(node.text)) hits.push(node.text);
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') hits.push('new Function');
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) hits.push('import()');
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(hits, file).toEqual([]);
    }
  });
});

describe('repository hygiene', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

  it('no em dash appears in any text file of the extension (user-facing copy must not use them)', () => {
    const files = walk(root).filter((f) => /\.(ts|mts|mjs|json|html|css|md)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes(EM_DASH)).map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
