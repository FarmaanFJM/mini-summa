# Mini-Summa tab focus

An optional Chrome extension (Manifest V3) for Mini-Summa's **external browser** mode. When Mini-Summa wants to show a
mapped ChatGPT conversation, it asks this extension to bring the tab you already have open to the front instead of
opening a duplicate. If there is no such tab, the extension opens one.

It works in Chrome, Edge, Brave and other Chromium browsers (version 121 or newer). Mini-Summa works without it: the
clipboard handoff is the same, only the tab handling differs.

## Install (unpacked)

1. Build it: `node apps/browser-extension/build.mjs` (or `npm run build -w @minisumma/browser-extension`). The result is
   in `apps/browser-extension/dist/`.
2. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked** and select the `dist` folder.
3. Click the extension's toolbar button (pin it from the puzzle menu if you do not see it) to open its settings.

Do not load a build made with `--test-hosts`; it is labelled "(test build)" and exists only for the automated browser test.

## Pair it with Mini-Summa

1. In Mini-Summa open **Settings, Browser extension** and create a pairing code.
2. In the extension settings paste the `minisumma://pair?...` link into **Pairing link** and press **Pair**.
   Or open **Enter the details manually** and type the **Offer id** and **Code**.
3. The status line should read **Connected**. The **Core address** (default `http://127.0.0.1:47811`) can be changed
   there if Mini-Summa listens on another port.

The extension accepts only `http://127.0.0.1:<port>` and `http://localhost:<port>`. Mini-Summa listens on this computer
only, so nothing else makes sense, and the token can never be sent to another host by mistake.

**Unpair this browser** only forgets the token here. To revoke it for good, remove the device in Mini-Summa. If you
remove it there first, the extension notices (the connection is closed with code 4003) and shows *This browser was
unpaired in Mini-Summa*.

## What it does

Mini-Summa sends one of two requests over a WebSocket (`/ws`, scope `extension`). The extension answers with
`bridge.result`.

| Request | What the extension does |
| --- | --- |
| `focus_or_open { url }` | Normalizes the address with the shared `parseChatGptUrl`. Looks for a tab showing the same page (`sameChatGptPage`), preferring the active tab, then the most recently used one. If found: makes it the active tab and brings its window to the front. If not: opens the address in a new tab, brings that window to the front and waits up to 15 seconds for the load to finish. |
| `list_chatgpt_tabs` | Returns the open ChatGPT tabs (`tabId`, `windowId`, `url`, `title`, `active`). |

Anything that is not an `https` address on `chatgpt.com`, `www.chatgpt.com` or `chat.openai.com` is refused with
`ok: false` and a plain sentence. One request is handled at a time, so two quick requests for the same page cannot open
two tabs.

A successful `focus_or_open` answers with `{ mode: "focused" | "opened", tabId, windowId, url, title, urlMatches }` plus
additive fields: `windowFocused` and `note`, and `focused`, `opened`, `verified`, the same facts under the names that
`packages/core/src/http/bridge.ts` reads into `ChatGptOpenResult` (`focused` = `windowFocused`, `opened` = mode is
"opened", `verified` = `urlMatches`, or `null` when the page had not finished loading).

* `urlMatches` is true only if the address the tab ended up at is the same ChatGPT page that was requested. After a
  redirect to a sign-in page it is false. **It is an address check, not a content check:** the extension never looks at
  the page.
* If the tab ended on another site (a sign-in page on a different host is the usual case), the browser does not show the
  extension that address or its title: `url` and `title` are empty, `urlMatches` and `verified` are false and `note` says
  the tab finished loading on another site. A tab that is simply still loading has no address either, which is why this
  is only concluded once the browser reports the load as finished.
* `windowFocused` is what the browser reported after the window was asked to come to the front. False means it was not
  confirmed (for example the operating system refused to give focus), and `note` says so.
* If the browser labels the tab with the site name only, which is how it labels its own "this site can't be reached"
  page (it still reports the requested address for that page), `urlMatches` is false and `note` says the browser may be
  showing an error page. That check is a heuristic, because the title is all the extension can see.
* A tab that has not finished loading after 15 seconds is reported as opened with `urlMatches: false`.
* After the page finishes loading the extension waits until the address has stayed the same for half a second, so a
  redirect that a page triggers from script right after loading is still seen. A redirect that happens later is not.

## Permissions, and why

The complete list in `manifest.json`:

| Permission | Why it is needed |
| --- | --- |
| `storage` | Keeps the core address and the pairing token in `chrome.storage.local` on this computer. |
| `alarms` | A 30 second heartbeat that wakes the background worker if the browser stopped it, so the connection comes back. It exists only while the browser is paired. |
| `https://chatgpt.com/*`, `https://www.chatgpt.com/*`, `https://chat.openai.com/*` | Host access to the three ChatGPT addresses. It is what lets the browser show the extension the address and title of a tab on these sites, which is how it recognizes the tab that shows a conversation and learns where a tab it opened ended up. `tabs.query`, `tabs.get`, `tabs.update`, `tabs.create` and `windows.update` need no permission of their own. |
| `http://127.0.0.1/*`, `http://localhost/*` | The Mini-Summa core, which listens on this computer only. Lets the settings page call the core's pairing endpoint without CORS headers. |

**The `tabs` permission is not requested.** Without it the browser shows an extension the address and title of a tab only
for sites the extension has host access to, so this extension cannot see the URLs or titles of tabs on other sites: such
tabs come back from the browser without those fields (checked in a real browser by `test/real-browser.mjs`), and every
tab lookup it makes is a `tabs.query` filtered to the ChatGPT addresses, or `tabs.get` for the id of a tab it just
selected or opened. Host access to the ChatGPT sites does not let the extension read or change those pages: there is no
content script and no `scripting` permission.

Not requested: `tabs`, `<all_urls>`, `activeTab`, `scripting`, `webNavigation`, `webRequest`, `cookies`, `history`,
`downloads`, content scripts, optional permissions. The manifest's content security policy additionally limits
connections from the extension to this computer (`connect-src` loopback only). When you install it, Chrome shows its own
notice for the host access above; that is the only access the extension asks for.

### Chrome APIs used

`chrome.tabs.query`, `chrome.tabs.get`, `chrome.tabs.update`, `chrome.tabs.create`, `chrome.windows.update` (all in
`src/bridge.ts`, listed in its header), plus `chrome.storage.local`, `chrome.storage.onChanged`, `chrome.alarms`,
`chrome.runtime.onMessage` / `sendMessage` / `openOptionsPage` and `chrome.action.onClicked`. `test/policy.test.ts`
fails if the code uses anything else, and `test/build.test.ts` checks the same on the shipped bundles.

## What it does not do

* It injects nothing into any page: no content scripts, no `chrome.scripting`.
* It never reads page content, never types, clicks, scrolls or submits anything in ChatGPT.
* It does not close, move, reload or navigate tabs that already exist. It only selects them.
* It cannot see the address or title of tabs on other sites (it has no `tabs` permission), and it never asks for them.
* It does not talk to any server except the Mini-Summa core on this computer, and it does not contact chatgpt.com
  itself. The only network traffic is to `127.0.0.1` or `localhost`.
* It does not run in incognito windows unless you allow that for the extension on `chrome://extensions`.

## Limits worth knowing

* The extension asks the browser to bring a window forward; the operating system decides whether to allow it (Windows
  can refuse to let a background program take the foreground). The answer says `windowFocused: false` when the browser
  did not confirm it. Whether a minimized window is restored is the browser's and the system's choice.
* After a redirect to another site the extension cannot say where the tab is, only that it is not the requested page.
* `urlMatches` and `verified` are address checks. A page that is signed out but still at the conversation address, or a
  conversation that no longer exists, cannot be told apart without reading the page, which this extension never does.
* New tabs open in the browser's last used window. If no browser window exists at all, what `chrome.tabs.create` does is
  up to the browser (not tested).

## Staying connected

The background worker opens `ws://<core address>/ws`, sends `hello` (`client: "browser-extension"`, no topics) and is
connected once the core answers `ready`. It pings every 25 seconds, which also keeps the Manifest V3 worker awake
(traffic on an open WebSocket resets Chrome's 30 second idle timer), and drops a connection that has been silent for 70
seconds. After a failure it retries after 0.5 s, 1 s, 2 s, ... up to 15 s, and starts at 0.5 s again after a success. The
alarm is at most every 30 seconds because that is the shortest period Chrome allows; it only matters when the worker
had been stopped. Close code 4003 (device revoked, or a token without the extension scope) and 4401 (token not known to
the core) both mean the token will never work: it is deleted and the extension does not retry until you pair again.

| Status | Meaning |
| --- | --- |
| Not paired | No token stored. |
| Connecting | A connection attempt is running. |
| Connected | The core answered `ready`. If the pairing lacks the `extension` scope the page says it is not allowed to answer. |
| Mini-Summa is not reachable | The app is not running or the address is wrong. The page shows when the next attempt happens. |
| This browser was unpaired in Mini-Summa | The core revoked this device. Pair again with a new code. |

Notes for the core: it must accept a WebSocket handshake whose `Origin` is `chrome-extension://<extension id>` on `/ws`
and a `pairing.redeem` POST with that origin (both are true today). A `focus_or_open` that has to open a new tab answers
only after the page finished loading: at most 15 seconds, plus half a second of settling. The core's bridge timeout is 18
seconds (`bridgeTimeoutMs` in `packages/core/src/http/types.ts`), so that always fits, and `test/with-real-core.mjs`
checks it with a page that never answers.

## Development

```
node apps/browser-extension/build.mjs                  # production build into dist/
node apps/browser-extension/build.mjs --test-hosts     # test variant, labelled "(test build)"
npx tsc -p apps/browser-extension/tsconfig.json        # typecheck
npx vitest run --root apps/browser-extension           # unit tests
node apps/browser-extension/build.mjs --test-hosts && xvfb-run -a node apps/browser-extension/test/real-browser.mjs
xvfb-run -a node apps/browser-extension/test/with-real-core.mjs   # real browser against the real headless core
xvfb-run -a node apps/browser-extension/test/keepalive.mjs        # about two minutes: is the worker kept alive
```

The unit tests run the bridge against a fake `chrome.tabs` / `chrome.windows`, the connection against a fake WebSocket
and a virtual clock, the pairing flow against a fake `fetch`, and check the manifest, the Chrome API list, the build
output and the icons. The test variant allows the same loopback patterns the production manifest already has for the
core, so its code is identical to production; the real-browser test proves that by comparing the bundles byte for byte.

`test/real-browser.mjs` starts headed Chromium with the extension loaded, a fake core and a local HTTPS server (throwaway
certificate made with `openssl`) that stands in for ChatGPT under the names `chatgpt.com`, `www.chatgpt.com` and
`chat.openai.com`, plus one unrelated name (`accounts.other-site.example`) used to check what the extension may see.

**No test or script here can reach the real ChatGPT.** The browser is started with `--host-resolver-rules` that map those
names to the local server and make every other name unresolvable, and with `--no-proxy-server`. Every script that starts
a browser proves that before using it (`launchBrowser` in `test/support.mjs`; `keepalive.mjs` makes the same first check
itself): first a navigation to a public name that is not ChatGPT (`https://example.com/`) must fail with
`ERR_NAME_NOT_RESOLVED`, and only then are the ChatGPT names tried, each of which must be answered by that run's own
stand-in (a random value in a response header). If the rules are missing or ignored, the first check fails and the script
stops before any ChatGPT address has been used. Request interception in the test framework is not used for this, because
it does not cover tabs that the browser opens by itself.

The test pairs through the real settings page, then checks focusing, opening, windows, redirects (to the same site and to
another site), load failures, the 15 second limit, `list_chatgpt_tabs`, that the extension cannot see the address or title
of a tab on another site, reconnecting, revocation and unpairing, and that no content script ran (page DOM unchanged, no
extension execution context in the page; a control extension that does inject a script is detected by the same checks).
Set `MINISUMMA_SCREENSHOTS=<folder>` to keep pictures of the settings page, `MINISUMMA_CHROMIUM` to choose the browser
binary and `MINISUMMA_EXT_DIR` to test another build. It needs `xvfb-run`, `openssl` and a Chromium.

`test/with-real-core.mjs` runs the same browser against the real core (`packages/core/src/cli.ts`, started as a child
process with a temporary data directory): the extension is paired by pasting the core's own pairing link, and the core's
own `POST /conversations/:id/open` is used to open and focus tabs, so the answer checked is the `ChatGptOpenResult` the
rest of Mini-Summa sees. Removing the device in the core must make the extension show the unpaired message.

`test/keepalive.mjs` (about two minutes, run on its own) answers one question that the Playwright based test cannot,
because DevTools keeps an attached service worker alive: does Chrome stop the worker while the extension is connected?
It starts Chromium itself, attaches only to the settings page (closed again before the observation), and runs an
unpaired control next to the paired extension. The control's worker must be stopped by the browser (it was, after about
31 seconds); the paired worker must keep running with one unbroken connection and pings arriving at least every 27 seconds.

The settings page follows the pinned Summa-UI guidance in `third_party/summa-ui-guidance` (its tokens and controls are
included into `dist/options.css` at build time).
