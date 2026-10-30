# The ChatGPT pane

## What it is

One native browser view (an Electron `WebContentsView`) laid over the ChatGPT pane of the workspace. It has its own persistent
session, so the login stays, and it is sandboxed with no preload. It is created the first time a conversation is shown and is
never destroyed because of layout: hiding the pane, maximizing the other one, opening Settings or a dialog and resizing the window
only hide or move it, so the page, its scroll position and a half-written message stay. The log has one line, `chatgpt view
created`, per run.

## What Mini-Summa does to the page, and what it does not

It loads the address you mapped, keeps the view on ChatGPT, OpenAI and sign-in hosts (anything else opens in your browser), places
the view over the pane, and sets the view's browser zoom (below). That is all.

It does not inject CSS or scripts, read or change the page, click, type, press Send, change the user agent or hide any ChatGPT
control. The page may use exactly one permission, `clipboard-sanitized-write`. That is what its own Copy buttons (copying a writing
block as Markdown, say) use, and it can only put text or an image on the clipboard. Reading the clipboard, the camera, the
microphone, notifications and the location are refused. This permission was already allowed before the page size setting existed,
and nothing here changes it.

## The overlap report, and what is only a hypothesis

Reported: ChatGPT's floating navigation and overflow controls sit over the writing blocks, which makes them awkward to use and
copying Markdown hard. **It was not reproduced.** chatgpt.com cannot be reached from where this was built, it needs a login, and
OpenAI documents nothing about its responsive layout.

The most likely cause, and still only a guess: ChatGPT lays itself out by the width it is given in CSS pixels. The view is as wide as
its pane in device independent pixels (DIP), and at 100 percent zoom one DIP is one CSS pixel. A split pane on a 1280 to 1440 wide
window, or on a Windows laptop at 125 to 150 percent display scaling (1920 pixels at 150 percent is 1280 DIP), is only about 500 to
650 pixels wide. A responsive site is likely to switch to its compact layout there, and a compact layout is where floating buttons
end up on top of content. What the test suite did rule out is Mini-Summa's own geometry: at every window size tried, the native view
fills its pane exactly and covers none of Mini-Summa's controls.

## Page size (Settings, ChatGPT)

Automatic (the default), 100, 90, 80 or 70 percent. It is the view's own browser zoom, what Ctrl and minus do in a browser. The fixed
sizes apply as they are. Automatic leaves a pane of 900 DIP or more at 100 percent, and zooms a narrower one out just enough for the
page to get about 900 CSS pixels, never below 70 percent:

| Pane (DIP) | 500 | 585 | 630 | 700 | 800 | 899 | 900 or more |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Automatic zoom | 70% | 70% | 70% | 77% | 88% | 99% | 100% |
| ChatGPT sees (CSS px) | 714 | 835 | 900 | 909 | 909 | 908 | the pane |

The 900 and the 70 percent are judgements, not measurements of ChatGPT. They are `AUTO_TARGET_CSS_WIDTH` and `AUTO_MIN_ZOOM` in
`apps/desktop/src/main/pageScale.ts`, pinned by a test, and the one place to change if the check below finds a better figure.

Why zoom: moving the buttons with injected CSS would depend on ChatGPT's class names and markup, which change without notice, would
modify a third party's page and could hide or break the very controls you need. Zoom is a browser feature, needs no selector, works
whatever ChatGPT's layout is, and is undone with one setting. Its cost is smaller text. It follows the pane when the window or the
divider moves, when the setting changes, and after every navigation (Chromium keeps zoom per host, so the sign-in host starts at 100
percent, and a zoom set before the first page has loaded is ignored; both measured in Electron 45.1). It does not depend on the
Mini-Summa window's own zoom.

## What could not be verified

- **The real site.** The overlap was not reproduced, and neither that a narrow pane causes it nor that zooming out removes it is
  confirmed. The mechanism is tested against a stand-in page that reports its own `window.innerWidth` (acceptance test X08, Linux,
  Electron 45.1, Xvfb): the page gets the width the table says, and clicks, text selection, the wheel and the page's own Copy button
  still work while zoomed.
- **Windows**, including display scaling. Nothing here was run on Windows.

## Manual check on Windows (about 10 minutes)

1. Open a project whose conversation has a writing block (ask ChatGPT for a short draft) and sign in if asked.
2. Make the window the size where the overlap was seen (1280 or 1440 wide, or your laptop at 125 or 150 percent scaling) and show
   both panes, ChatGPT beside Claude.
3. Settings, ChatGPT: choose **100 percent**. Look at the writing block. Do the floating navigation and overflow buttons sit on its
   text? Select a sentence, scroll, and copy the block as Markdown with ChatGPT's own Copy (paste into Notepad to check).
4. Choose **Automatic** and look at the same block, then do the same three things.
5. Repeat 3 and 4 with the sidebar open and collapsed, and in ChatGPT focus mode (the workspace layout control set to ChatGPT, so it
   fills the window).
6. Drag the divider slowly: the page should resize in small steps, without reloading, and a half-written message should stay.

If 100 percent overlaps and Automatic does not, the hypothesis holds; tell us the window size and scaling so the 900 can be tuned.
If both overlap, even in focus mode, the cause is not the pane's width and this setting will not help. Either way, `%APPDATA%\Mini-Summa\logs\main.log` has a `chatgpt page zoom` line
(`factor`, `paneWidthDip`) each time the zoom changed, which says what was in force.
