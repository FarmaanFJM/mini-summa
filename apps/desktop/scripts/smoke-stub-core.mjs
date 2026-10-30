// A tiny stand-in for @minisumma/core, loaded through the MINISUMMA_CORE_MODULE seam (never in a packaged app).
// It serves a placeholder page under /ui/, a minimal /api/v1/health, and a few /__test/ endpoints that let the smoke
// test drive the REAL native bridge that the main process handed to createCore, exactly as the real core would.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mini-Summa stub core</title>
<style>html,body{margin:0;height:100%;background:#141515;color:#ececeb;font:14px system-ui,sans-serif}
#pane{position:absolute;left:300px;top:80px;width:700px;height:520px;border:1px dashed #6f7371;box-sizing:border-box}</style></head>
<body><h1 id="title">Stub core UI</h1><div id="pane">ChatGPT pane goes here</div>
<a id="outside" href="https://outside.invalid/page">outside</a></body></html>`;

export async function createCore(options) {
  const token = crypto.randomBytes(24).toString('hex');
  const state = { sessions: [], quiet: false, started: false, stopped: false, startedAt: null };
  const settings = { notifications: { quiet: { enabled: false, until: null } } };
  const subscribers = new Set();
  const note = (message, data) => options.log?.info(message, data);

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    try {
      if (url.pathname === '/api/v1/health') return json(res, 200, { ok: true, name: 'mini-summa-core', version: options.version, apiVersion: 1 });
      if (url.pathname === '/ui/' || url.pathname === '/ui/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (url.pathname === '/__test/options') {
        const { native, log, ...rest } = options;
        return json(res, 200, { ...rest, hasNative: !!native, hasLog: typeof log?.info === 'function', capabilities: native?.capabilities() });
      }
      if (url.pathname === '/__test/open') {
        const result = await options.native.chatgpt.open(url.searchParams.get('url'), { focus: url.searchParams.get('focus') !== '0', reason: url.searchParams.get('reason') ?? 'user' });
        return json(res, 200, result);
      }
      if (url.pathname === '/__test/verify') return json(res, 200, await options.native.chatgpt.verify(url.searchParams.get('url')));
      if (url.pathname === '/__test/state') return json(res, 200, options.native.chatgpt.state());
      if (url.pathname === '/__test/notify') {
        const n = JSON.parse(await readBody(req));
        return json(res, 200, await options.native.notify(n));
      }
      if (url.pathname === '/__test/clipboard') {
        const { text } = JSON.parse(await readBody(req));
        try { await options.native.clipboard.writeText(text); return json(res, 200, { ok: true }); } catch (error) { return json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      }
      if (url.pathname === '/__test/open-external') {
        const { url: target } = JSON.parse(await readBody(req));
        try { await options.native.openExternal(target); return json(res, 200, { ok: true }); } catch (error) { return json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      }
      if (url.pathname === '/__test/save') {
        const body = JSON.parse(await readBody(req));
        return json(res, 200, await options.native.saveTextFile(body));
      }
      if (url.pathname === '/__test/sessions') {
        state.sessions = JSON.parse(await readBody(req));
        for (const fn of subscribers) fn();
        return json(res, 200, { ok: true, count: state.sessions.length });
      }
      if (url.pathname === '/__test/status') return json(res, 200, { ...state, quiet: settings.notifications.quiet.enabled });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such route' } }));
    } catch (error) {
      json(res, 500, { error: { code: 'stub_failed', message: String(error?.message ?? error) } });
    }
  });

  let port = 0;
  const core = {
    get baseUrl() { return `http://127.0.0.1:${port}`; },
    desktopToken: token,
    base: {
      dataDir: options.dataDir,
      bus: {
        subscribe(fn) {
          const wrapper = () => fn(1, { type: 'counts', counts: core.counts() }, 'system');
          subscribers.add(wrapper);
          return () => subscribers.delete(wrapper);
        },
      },
    },
    services: {
      settings: {
        get: () => settings,
        update(patch) {
          const q = patch?.notifications?.quiet;
          if (q && typeof q.enabled === 'boolean') settings.notifications.quiet.enabled = q.enabled;
          for (const fn of subscribers) fn();
          return settings;
        },
        onChange: () => () => undefined,
      },
      sessions: { list: () => state.sessions },
    },
    counts: () => ({ unreadActivity: 2, actionsNeeded: 1, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: state.sessions.length }),
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
      port = server.address().port;
      state.started = true;
      state.startedAt = new Date().toISOString();
      note('stub core started', { port, token: 'must-not-be-logged' });
    },
    async stop() {
      // Leave proof that the app stopped the core before exiting.
      fs.mkdirSync(options.dataDir, { recursive: true });
      fs.writeFileSync(path.join(options.dataDir, 'stub-core-stopped.json'), JSON.stringify({ at: new Date().toISOString(), sessionsAtStop: state.sessions.length }));
      state.stopped = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return core;
}
