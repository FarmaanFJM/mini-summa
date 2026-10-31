// @vitest-environment node
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNativeBridge, sanitizeFileName } from '../../src/main/nativeBridge.ts';
import type { NativeBridgeDeps } from '../../src/main/nativeBridge.ts';

function setup(over: Partial<NativeBridgeDeps> = {}) {
  let clip = '';
  const deps: NativeBridgeDeps = {
    chatgpt: {
      open: vi.fn(async () => ({ ok: true, mode: 'embedded' as const, opened: true, focused: false, verified: true, finalUrl: 'https://chatgpt.com/c/x', title: 't', note: null })),
      verify: vi.fn(async () => ({ ok: true, mode: 'embedded' as const, opened: true, focused: false, verified: true, finalUrl: null, title: null, note: null })),
      getState: vi.fn(() => ({ mode: 'embedded' as const, status: 'idle' as const, url: null, title: null, canGoBack: false, canGoForward: false, note: null })),
    },
    notifier: { notify: vi.fn(async () => ({ shown: true })) },
    notificationsSupported: () => true,
    clipboard: { writeText: vi.fn(async (t: string) => { clip = t; }), readText: vi.fn(async () => clip) },
    openExternal: vi.fn(async () => undefined),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/home/me/Documents/report.md' })),
    writeFile: vi.fn(async () => undefined),
    documentsDir: () => '/home/me/Documents',
    ...over,
  };
  return { bridge: createNativeBridge(deps), deps };
}

describe('capabilities', () => {
  it('claims what the host really does and leaves the extension to the core', () => {
    expect(setup().bridge.capabilities()).toEqual({ clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true });
  });
  it('asks the system whether notifications work', () => {
    expect(setup({ notificationsSupported: () => false }).bridge.capabilities().notifications).toBe(false);
  });
});

describe('chatgpt', () => {
  it('delegates open, verify and state to the view', async () => {
    const { bridge, deps } = setup();
    await bridge.chatgpt.open('https://chatgpt.com/c/x', { focus: true, reason: 'handoff' });
    expect(deps.chatgpt.open).toHaveBeenCalledWith('https://chatgpt.com/c/x', { focus: true, reason: 'handoff' });
    await bridge.chatgpt.verify('https://chatgpt.com/c/x');
    expect(deps.chatgpt.verify).toHaveBeenCalledWith('https://chatgpt.com/c/x');
    expect(bridge.chatgpt.state().status).toBe('idle');
  });
});

describe('clipboard', () => {
  it('writes and confirms by reading back', async () => {
    const { bridge, deps } = setup();
    await bridge.clipboard.writeText('report\nline 2');
    expect(deps.clipboard.writeText).toHaveBeenCalledWith('report\nline 2');
    expect(deps.clipboard.readText).toHaveBeenCalled();
  });

  it('accepts the platform turning line feeds into carriage returns', async () => {
    let clip = '';
    const { bridge } = setup({ clipboard: { writeText: async (t) => { clip = t.replace(/\n/g, '\r\n'); }, readText: async () => clip } });
    await expect(bridge.clipboard.writeText('a\nb\nc')).resolves.toBeUndefined();
  });

  it('throws when the clipboard did not take the text (never pretend)', async () => {
    const { bridge } = setup({ clipboard: { writeText: async () => undefined, readText: async () => 'something else that was already there' } });
    await expect(bridge.clipboard.writeText('the report')).rejects.toThrow(/did not accept/);
  });

  it('throws when the write itself fails', async () => {
    const { bridge } = setup({ clipboard: { writeText: async () => { throw new Error('locked'); }, readText: async () => '' } });
    await expect(bridge.clipboard.writeText('x')).rejects.toThrow('locked');
  });

  it('refuses non-text', async () => {
    const { bridge, deps } = setup();
    await expect(bridge.clipboard.writeText(42 as unknown as string)).rejects.toThrow(/Invalid/);
    expect(deps.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('notify', () => {
  it('passes the notification through and returns the notifier result', async () => {
    const { bridge, deps } = setup({ notifier: { notify: vi.fn(async () => ({ shown: false, reason: 'Do not disturb' })) } });
    const n = { title: 't', body: 'b', tag: 'x', target: { view: 'activity' as const }, urgency: 'normal' as const, silent: false };
    expect(await bridge.notify(n)).toEqual({ shown: false, reason: 'Do not disturb' });
    expect(deps.notifier.notify).toHaveBeenCalledWith(n);
  });
});

describe('openExternal', () => {
  it('opens plain https links', async () => {
    const { bridge, deps } = setup();
    await bridge.openExternal('https://example.org/a');
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.org/a');
  });
  it.each(['http://example.org/', 'file:///C:/x', 'javascript:alert(1)', 'https://u:p@example.org/', ''])('refuses %s', async (url) => {
    const { bridge, deps } = setup();
    await expect(bridge.openExternal(url)).rejects.toThrow(/Invalid link/);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});

describe('saveTextFile', () => {
  it('offers a safe name in the documents folder, writes UTF-8 and returns the chosen path', async () => {
    const { bridge, deps } = setup();
    const r = await bridge.saveTextFile({ suggestedName: 'Report: api/v2?.md', text: 'caf\u00e9' });
    expect(deps.showSaveDialog).toHaveBeenCalledWith({ defaultPath: path.join('/home/me/Documents', 'Report_ api_v2_.md') });
    expect(deps.writeFile).toHaveBeenCalledWith('/home/me/Documents/report.md', 'caf\u00e9');
    expect(r).toEqual({ path: '/home/me/Documents/report.md' });
  });

  it('returns null and writes nothing when the user cancels', async () => {
    const { bridge, deps } = setup({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    expect(await bridge.saveTextFile({ suggestedName: 'a.md', text: 'x' })).toEqual({ path: null });
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('lets a write error reach the caller', async () => {
    const { bridge } = setup({ writeFile: vi.fn(async () => { throw new Error('EACCES'); }) });
    await expect(bridge.saveTextFile({ suggestedName: 'a.md', text: 'x' })).rejects.toThrow('EACCES');
  });

  it('refuses non-text contents', async () => {
    const { bridge } = setup();
    await expect(bridge.saveTextFile({ suggestedName: 'a.md', text: 5 as unknown as string })).rejects.toThrow(/Invalid file contents/);
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['report.md', 'report.md'],
    ['../../etc/passwd', '.._.._etc_passwd'.replace(/^\.+/, '')],
    ['C:\\Windows\\win.ini', 'C__Windows_win.ini'],
    ['a<b>c:d"e|f?g*h.md', 'a_b_c_d_e_f_g_h.md'],
    ['  .hidden  ', 'hidden'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['', 'mini-summa-report.md'],
    ['...', 'mini-summa-report.md'],
    ['tab\tname\nline.md', 'tab_name_line.md'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
  it('limits the length and rejects non-strings', () => {
    expect(sanitizeFileName('a'.repeat(500)).length).toBe(120);
    expect(sanitizeFileName(undefined)).toBe('mini-summa-report.md');
    expect(sanitizeFileName(5)).toBe('mini-summa-report.md');
  });
});
