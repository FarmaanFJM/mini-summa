// The shared EventStream ignores the WebSocket close event, but the desktop tells a removed phone apart from a dropped
// connection by close code 4003. This wrapper forwards every event unchanged and reports the close code on the side.
import type { WebSocketCtor, WebSocketLike } from '@minisumma/shared';

export type CloseObserver = (code: number | null, reason: string) => void;

export function observeWebSocket(Base: WebSocketCtor, observer: CloseObserver): WebSocketCtor {
  return class ObservedSocket implements WebSocketLike {
    onopen: WebSocketLike['onopen'] = null;
    onmessage: WebSocketLike['onmessage'] = null;
    onclose: WebSocketLike['onclose'] = null;
    onerror: WebSocketLike['onerror'] = null;
    private readonly inner: WebSocketLike;

    constructor(url: string) {
      this.inner = new Base(url);
      this.inner.onopen = (ev) => this.onopen?.(ev);
      this.inner.onmessage = (ev) => this.onmessage?.(ev);
      this.inner.onerror = (ev) => this.onerror?.(ev);
      this.inner.onclose = (ev) => {
        const e = (ev ?? {}) as { code?: unknown; reason?: unknown };
        observer(typeof e.code === 'number' ? e.code : null, typeof e.reason === 'string' ? e.reason : '');
        this.onclose?.(ev);
      };
    }

    get readyState(): number { return this.inner.readyState; }
    send(data: string): void { this.inner.send(data); }
    close(code?: number, reason?: string): void { this.inner.close(code, reason); }
  };
}
