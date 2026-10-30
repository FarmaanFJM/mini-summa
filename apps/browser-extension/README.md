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
two additive fields, `windowFocused` and `note`.

* `urlMatches` is true only if the address the tab ended up at is the same ChatGPT page that was requested. After a
  redirect to a sign-in page it is false. **It is an address check, not a content check:** the extension never looks at
  the page.
* `windowFocused` is what the browser reported after the window was asked to come to the front. False means it was not
  confirmed (for example the operating system refused to give focus), and `note` says so.
* If the browser labels the tab with the site name only, which is how it labels its own "this site can't be reached"
  page (it still reports the requested address for that page), `urlMatches` is false and `note` says the browser may be
  showing an error page. That check is a heuristic, because the title is all the extension can see.
* A tab that has not finished loading after 15 seconds is reported as opened with `urlMatches: false`.
* After the page finishes loading the extension waits until the address has stayed the same for half a second, so a
  redirect that a page triggers from script right after loading is still seen. A redirect that happens later is not.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `tabs` | Lets the extension read the address and title of tabs, which is how it recognizes the tab showing a conversation, and `tabs.update` / `tabs.create` to select or open it. The extension always asks the browser for ChatGPT tabs only (`tabs.query` with a `url` filter), so tabs of other sites are never handed to its code. |
| `storage` | Keeps the core address and the pairing token in `chrome.storage.local` on this computer. |
| `alarms` | A 30 second heartbeat that wakes the background worker if the browser stopped it, so the connection comes back. It exists only while the browser is paired. |
| `https://chatgpt.com/*`, `https://chat.openai.com/*` | The only web sites the extension is about. |
| `http://127.0.0.1/*`, `http://localhost/*` | The Mini-Summa core. Lets the settings page call the core's pairing endpoint without CORS headers. |

Not requested: `<all_urls>`, `activeTab`, `scripting`, `webNavigation`, `webRequest`, `cookies`, `history`,
`downloads`, content scripts, optional permissions. The manifest's content security policy additionally limits
connections from the extension to this computer (`connect-src` loopback only).

Chrome words these in its own way when you install: `tabs` appears as "Read your browsing history" and host access as
"Read and change your data on chatgpt.com ...". Those are Chrome's standard wordings for the permission, and they are
broader than what this extension does with it.

Honest note: with `tabs` granted, the ChatGPT host patterns add no capability the code uses, and the other way round,
the host patterns alone would be enough for ChatGPT tabs. Both are listed because the design asked for both.

### Chrome APIs used

`chrome.tabs.query`, `chrome.tabs.get`, `chrome.tabs.update`, `chrome.tabs.create`, `chrome.windows.update` (all in
`src/bridge.ts`, listed in its header), plus `chrome.storage.local`, `chrome.storage.onChanged`, `chrome.alarms`,
`chrome.runtime.onMessage` / `sendMessage` / `openOptionsPage` and `chrome.action.onClicked`. `test/policy.test.ts`
fails if the code uses anything else, and `test/build.test.ts` checks the same on the shipped bundles.

## What it does not do

* It injects nothing into any page: no content scripts, no `chrome.scripting`.
* It never reads page content, never types, clicks, scrolls or submits anything in ChatGPT.
* It does not close, move, reload or navigate tabs that already exist. It only selects them.
* It does not look at tabs of other sites (the `url` filter keeps them out of its sight).
* It does not talk to any server except the Mini-Summa core on this computer, and it does not contact chatgpt.com
  itself. The only network traffic is to `127.0.0.1` or `localhost`.
* It does not run in incognito windows unless you allow that for the extension on `chrome://extensions`.

## Staying connected

The background worker opens `ws://<core address>/ws`, sends `hello` (`client: "browser-extension"`, no topics) and is
connected once the core answers `ready`. It pings every 25 seconds, which also keeps the Manifest V3 worker awake
(traffic on an open WebSocket resets Chrome's 30 second idle timer), and drops a connection that has been silent for 70
seconds. After a failure it retries after 0.5 s, 1 s, 2 s, ... up to 15 s, and starts at 0.5 s again after a success. The
alarm is at most every 30 seconds because that is the shortest period Chrome allows; it only matters when the worker
had been stopped. Close code 4003 means the device was revoked: the token is deleted and the extension does not retry
until you pair again.

| Status | Meaning |
| --- | --- |
| Not paired | No token stored. |
| Connecting | A connection attempt is running. |
| Connected | The core answered `ready`. If the pairing lacks the `extension` scope the page says it is not allowed to answer. |
| Mini-Summa is not reachable | The app is not running or the address is wrong. The page shows when the next attempt happens. |
| This browser was unpaired in Mini-Summa | The core revoked this device. Pair again with a new code. |

The core must accept a WebSocket handshake whose `Origin` is `chrome-extension://<extension id>` on `/ws`.

## Development

```
node apps/browser-extension/build.mjs                  # production build into dist/
node apps/browser-extension/build.mjs --test-hosts     # test variant, labelled "(test build)"
npx tsc -p apps/browser-extension/tsconfig.json        # typecheck
npx vitest run --root apps/browser-extension           # unit tests
node apps/browser-extension/build.mjs --test-hosts && xvfb-run -a node apps/browser-extension/test/real-browser.mjs
```

The unit tests run the bridge against a fake `chrome.tabs` / `chrome.windows`, the connection against a fake WebSocket
and a virtual clock, the pairing flow against a fake `fetch`, and check the manifest, the Chrome API list, the build
output and the icons. The test variant allows the same loopback patterns the production manifest already has for the
core, so its code is identical to production; the real-browser test proves that by comparing the bundles byte for byte.

`test/real-browser.mjs` starts headed Chromium with the extension loaded, a fake core and a local HTTPS server that
stands in for ChatGPT under the names `chatgpt.com` and `chat.openai.com`. The browser is started with
`--host-resolver-rules` so that those two names resolve to the local server and every other name does not resolve at
all, which means the real ChatGPT cannot be reached, and a canary navigation to another public name must fail before
anything else runs. It pairs through the real settings page, then checks focusing, opening, windows, redirects, load
failures, the 15 second limit, `list_chatgpt_tabs`, reconnecting, revocation and unpairing, and that no content script
ran (page DOM unchanged, no extension execution context in the page; a control extension that does inject a script is
detected by the same checks). Set `MINISUMMA_SCREENSHOTS=<folder>` to keep pictures of the settings page,
`MINISUMMA_CHROMIUM` to choose the browser binary and `MINISUMMA_EXT_DIR` to test another build.

The settings page follows the pinned Summa-UI guidance in `third_party/summa-ui-guidance` (its tokens and controls are
included into `dist/options.css` at build time).
