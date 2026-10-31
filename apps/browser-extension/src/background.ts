// MV3 service worker. It keeps one WebSocket to the Mini-Summa core, answers bridge requests with the tab/window
// bridge, and exposes its status to the options page. All state lives in chrome.storage.local, because the worker can
// be stopped by the browser at any time and is started again by the next event (an alarm, a message, the toolbar button).
import { createBridge } from './bridge.ts';
import { CoreConnection } from './connection.ts';
import type { SocketCtor } from './connection.ts';
import type { BackgroundRequest, BackgroundResponse } from './status.ts';
import { loadState, markRevoked, WATCHED_KEYS } from './storage.ts';

const HEARTBEAT_ALARM = 'minisumma-heartbeat';
/** Chrome does not honour alarms shorter than 30 s in an installed extension. The 25 s ping timer inside the
 *  connection covers the time the worker is awake; this alarm wakes it up again if the browser stopped it. */
const HEARTBEAT_PERIOD_MINUTES = 0.5;

const connection = new CoreConnection({
  WebSocket: WebSocket as unknown as SocketCtor,
  store: {
    load: () => loadState(chrome.storage.local),
    markRevoked: () => markRevoked(chrome.storage.local, Date.now()),
  },
  bridge: createBridge({ chrome }),
});

/** The heartbeat only runs while there is a token: an unpaired extension should not wake the browser every 30 s. */
async function syncHeartbeat(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (connection.isPaired() && !existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
  else if (!connection.isPaired() && existing) await chrome.alarms.clear(HEARTBEAT_ALARM);
}

// Listeners are registered synchronously at the top level, as MV3 requires, so the event that woke the worker is delivered.
const started = connection.start().then(syncHeartbeat).catch(() => undefined);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !WATCHED_KEYS.some((key) => key in changes)) return;
  void connection.reload().then(syncHeartbeat).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void started.then(() => connection.heartbeat());
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const request = message as Partial<BackgroundRequest> | null;
  if (request?.type !== 'get-status') return false;
  void started.then(() => {
    const response: BackgroundResponse = { type: 'status', status: connection.status() };
    sendResponse(response);
  });
  return true; // the answer is sent asynchronously
});

chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
