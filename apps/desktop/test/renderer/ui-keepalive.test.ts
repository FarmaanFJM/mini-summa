// The last remembered change, sent as the page closes: a request that outlives the page, to the core's settings route, and nothing
// else. And which refusals are worth asking again about.
import { ApiError } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import { keepaliveSender } from '../../src/renderer/src/app/keepalive';
import { isPermanentRefusal } from '../../src/renderer/src/app/uiSync';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the request that outlives the page', () => {
  it('is a PATCH of the settings route with keepalive and the desktop token, carrying only the window state', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const send = keepaliveSender(async () => ({ baseUrl: 'http://127.0.0.1:47811/', token: 'fake-desktop-token' }), fetchImpl as unknown as typeof fetch);
    await flush();
    send({ ui: { route: { projectId: 'prj_a', view: 'workspace' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47811/api/v1/settings');
    expect(init.method).toBe('PATCH');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fake-desktop-token');
    expect(JSON.parse(String(init.body))).toEqual({ ui: { route: { projectId: 'prj_a', view: 'workspace' } } });
  });

  it('does nothing until the address and token are known, and nothing when they cannot be had', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    let resolve!: (c: { baseUrl: string; token: string }) => void;
    const send = keepaliveSender(() => new Promise((r) => { resolve = r; }), fetchImpl as unknown as typeof fetch);
    send({ ui: { setup: { dismissed: true } } });
    expect(fetchImpl).not.toHaveBeenCalled();
    resolve({ baseUrl: 'http://127.0.0.1:1', token: 't' });
    await flush();
    send({ ui: { setup: { dismissed: true } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const unreachable = vi.fn(async () => new Response('{}'));
    const quiet = keepaliveSender(async () => { throw new Error('no core'); }, unreachable as unknown as typeof fetch);
    await flush();
    expect(() => quiet({ ui: { setup: { dismissed: true } } })).not.toThrow();
    expect(unreachable).not.toHaveBeenCalled();
  });

  it('never throws, whatever the request does: the page is going away', async () => {
    const send = keepaliveSender(async () => ({ baseUrl: 'http://127.0.0.1:1', token: 't' }), (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    await flush();
    expect(() => send({ ui: { setup: { seenEmpty: true } } })).not.toThrow();
    const sync = keepaliveSender(async () => ({ baseUrl: 'http://127.0.0.1:1', token: 't' }), (() => { throw new Error('blocked'); }) as unknown as typeof fetch);
    await flush();
    expect(() => sync({ ui: { setup: { seenEmpty: true } } })).not.toThrow();
  });
});

describe('which refusals are asked about again', () => {
  it('asks again after a network failure, a timeout, a busy or overloaded core and a server error', () => {
    for (const status of [0, 408, 425, 429, 500, 502, 503]) expect(isPermanentRefusal(new ApiError(status, 'x', 'x')), String(status)).toBe(false);
    expect(isPermanentRefusal(new Error('network down'))).toBe(false);
  });

  it('does not ask again after a refusal that sending the same thing cannot fix', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422]) expect(isPermanentRefusal(new ApiError(status, 'x', 'x')), String(status)).toBe(true);
  });
});
