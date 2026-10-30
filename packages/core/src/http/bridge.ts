// Extension bridge: asks the browser extension (connected over /ws with the `extension` scope) to focus an already
// open ChatGPT tab or open a new one, and reports only what the extension itself reported.
//
// Protocol (shared/events.ts): core -> extension `{t:'bridge.request', requestId, action:{kind:'focus_or_open', url}}`,
// extension -> core `{t:'bridge.result', requestId, ok, data?, error?}`. For `data` this module reads, if present:
// `focused: boolean`, `opened: boolean`, `verified: boolean`, `url: string`, `title: string`, `note: string`. Anything
// missing stays false/null: Mini-Summa never claims a focus, an open or a verification the extension did not report.
import { randomUUID } from 'node:crypto';
import { parseChatGptUrl } from '@minisumma/shared';
import type { ChatGptOpenResult, ServerMessage } from '@minisumma/shared';
import type { ExtensionBridge } from '../contracts.ts';

export interface BridgePeer {
  send(msg: ServerMessage): boolean;
  isOpen(): boolean;
}

export interface BridgeReply { requestId: string; ok: boolean; data?: unknown; error?: string }

export interface BridgeHub {
  bridge: ExtensionBridge;
  register(peer: BridgePeer): void;
  unregister(peer: BridgePeer): void;
  /** A `bridge.result` from `peer`. Ignored unless that very peer was asked for that requestId. */
  onResult(peer: BridgePeer, reply: BridgeReply): void;
}

type Outcome = { kind: 'reply'; reply: BridgeReply } | { kind: 'timeout' } | { kind: 'closed' };

const failure = (mode: ChatGptOpenResult['mode'], note: string): ChatGptOpenResult =>
  ({ ok: false, mode, opened: false, focused: false, verified: null, finalUrl: null, title: null, note });

const plainSeconds = (ms: number): string => {
  const s = ms >= 1000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10;
  return `${s} ${s === 1 ? 'second' : 'seconds'}`;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 2000) : null);

export function resultOfReply(reply: BridgeReply): ChatGptOpenResult {
  if (!reply.ok) {
    return failure('extension', str(reply.error) ?? 'The browser extension could not open the page. Open the conversation in your browser yourself.');
  }
  const d = (reply.data !== null && typeof reply.data === 'object' ? reply.data : {}) as Record<string, unknown>;
  const focused = d.focused === true;
  const opened = d.opened === true;
  const verified = typeof d.verified === 'boolean' ? d.verified : null;
  const note = str(d.note)
    ?? (focused || opened ? null : 'The extension answered without saying whether it focused or opened a tab, so Mini-Summa cannot tell which page is showing.');
  return { ok: true, mode: 'extension', opened, focused, verified, finalUrl: str(d.url), title: str(d.title), note };
}

export function createBridgeHub(opts: { timeoutMs: number }): BridgeHub {
  /** Registration order: the last open peer is the most recent extension connection. */
  const peers: BridgePeer[] = [];
  const pending = new Map<string, { peer: BridgePeer; settle: (o: Outcome) => void }>();

  const latestOpen = (): BridgePeer | null => {
    for (let i = peers.length - 1; i >= 0; i--) if (peers[i].isOpen()) return peers[i];
    return null;
  };

  const bridge: ExtensionBridge = {
    connected: () => latestOpen() !== null,
    async openOrFocus(url) {
      const parsed = parseChatGptUrl(url);
      if (!parsed.ok) return failure('extension', 'Only chatgpt.com conversation addresses can be opened through the browser extension.');
      const peer = latestOpen();
      if (!peer) {
        return failure('none', 'No browser extension is connected. Open your browser with the Mini-Summa extension enabled, or switch to opening links in the default browser.');
      }
      const requestId = randomUUID();
      const outcome = await new Promise<Outcome>((resolve) => {
        const timer = setTimeout(() => settle({ kind: 'timeout' }), opts.timeoutMs);
        function settle(o: Outcome): void {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(o);
        }
        pending.set(requestId, { peer, settle });
        if (!peer.send({ t: 'bridge.request', requestId, action: { kind: 'focus_or_open', url: parsed.info.url } })) settle({ kind: 'closed' });
      });
      if (outcome.kind === 'reply') return resultOfReply(outcome.reply);
      if (outcome.kind === 'closed') return failure('extension', 'The browser extension disconnected before it answered. Reconnect it, or open the conversation yourself.');
      return failure('extension', `The browser extension did not answer within ${plainSeconds(opts.timeoutMs)}. Check that the browser is open and the extension is enabled, or open the conversation yourself.`);
    },
  };

  return {
    bridge,
    register(peer) { if (!peers.includes(peer)) peers.push(peer); },
    unregister(peer) {
      const i = peers.indexOf(peer);
      if (i >= 0) peers.splice(i, 1);
      for (const p of [...pending.values()]) if (p.peer === peer) p.settle({ kind: 'closed' });
    },
    onResult(peer, reply) {
      const p = pending.get(reply.requestId);
      if (p && p.peer === peer) p.settle({ kind: 'reply', reply });
    },
  };
}
