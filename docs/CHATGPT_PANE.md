# The ChatGPT pane

## What it is

One native browser view (an Electron `WebContentsView`) laid over the ChatGPT pane of the workspace, **one for each project** (live
views, below), all in the one persistent session (`persist:chatgpt`), so the login stays and is shared, and sandboxed with no preload.
A view is created the first time a page is shown for its project and is never destroyed because of layout: hiding the pane,
maximizing the other one, opening Settings or a dialog, resizing the window and selecting another project only hide or move it, so
the page, its scroll position and a half-written message stay. The log has one line, `chatgpt view created`, for each view made;
the only thing that ever destroys one is the bound on live views, which logs `chatgpt view unloaded to stay within the limit`.

## Live views: one ChatGPT page for each project, within a bound

A project is a workspace, not a chat, so leaving it must not throw its ChatGPT page away. Each project has a view of its own
(`main/chatgptViews.ts`; the renderer names the project's view by its id in every ChatGPT call). Selecting another project shows
that project's view and hides this one: the conversation, the scroll position and an unsent draft are still there when you come back.

* **The bound is 4 live views** (`MAX_LIVE_CHATGPT_VIEWS`). Every live view keeps a renderer process with a ChatGPT page in memory even
  while hidden. **Measured** (X11, the real app on Linux under Xvfb, Electron's process metrics, four views in four processes): 88.7
  to 93.5 MB of working set per view, with the local stand-in page, which is a nearly empty document. **The real chatgpt.com page is
  much heavier and could not be measured here** (it needs a login and cannot be reached from where this was built); 100 to 250 MB a
  view is an estimate, not a measurement. Four views would then be roughly 0.4 to 1 GB.
* **When a fifth is needed** the least recently used view that is not the one on screen is destroyed, and you are told, not silently:
  "The ChatGPT page of <project> was unloaded to save memory. Unsent text there is gone; the page will reload at <address>." When you
  open that project again the page loads at its last address in a new view.
* **Mini-Summa never reads the page**, so it cannot know whether a draft was in an unloaded view; the notice always says unsent
  text is gone. **A draft survives switching projects and, only while the project stays within the bound, coming back. It does not
  survive an unload and it does not survive restarting Mini-Summa.** A restart restores only the last address of each project.
* Only the view of the project on screen is loaded after a start; the others load when you open them.
* Verified on Linux under Xvfb against the stand-in page (X11). **Windows: NOT TESTED.** How Chromium treats a hidden view of the real
  site (timers, suspended tabs, its own memory pressure) was not observed.

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
end up on top of content. What the test suite did rule out is Mini-Summa mis-sizing the view: at every window size and divider position
tried (X08, and A12 to A14), the native view's bounds equal the measured rectangle of its pane and stay out of the Claude pane. The width
it gets is the pane's width, nothing less.

## Page size

Settings, ChatGPT, The embedded view, Page size: Automatic (the default), 100%, 90%, 80% or 70%. It is the view's own browser
zoom, what Ctrl and minus do in a browser. The fixed sizes apply as they are. Automatic leaves a pane of 900 DIP or more at 100
percent, and zooms a narrower one out just enough for the page to get about 900 CSS pixels, never below 70 percent:

| Pane (DIP) | 500 | 585 | 630 | 700 | 800 | 899 | 900 or more |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Automatic zoom | 70% | 70% | 70% | 77% | 88% | 99% | 100% |
| ChatGPT sees (CSS px) | 714 | 835 | 900 | 909 | 909 | 908 | the pane |

The 900 and the 70 percent are judgements, not measurements of ChatGPT. They are `AUTO_TARGET_CSS_WIDTH` and `AUTO_MIN_ZOOM` in
`apps/desktop/src/main/pageScale.ts`, pinned by a test, and the one place to change if the check below finds a better figure. Below
630 DIP the floor wins and the page gets less than 900: about 714 CSS pixels in a split pane on a 1280 wide window (measured: 717), 488
at the smallest window. Whether that is enough depends on where ChatGPT's own layout changes, which nobody has measured, and is what
the check below finds out. Showing ChatGPT alone, or collapsing the sidebar, gives the page more room.

Why zoom: moving the buttons with injected CSS would depend on ChatGPT's class names and markup, which change without notice, would
modify a third party's page and could hide or break the very controls you need. Zoom is a browser feature, needs no selector, works
whatever ChatGPT's layout is, and is undone with one setting. Its cost is smaller text. It follows the pane when the window or the
divider moves, when the setting changes, and after every navigation (Chromium keeps zoom per host, so the sign-in host starts at 100
percent, and a zoom set before the first page has loaded is ignored; both measured in Electron 45.1). It does not depend on the
Mini-Summa window's own zoom.

## What could not be verified

- **The real site.** The overlap was not reproduced, and neither that a narrow pane causes it nor that zooming out removes it is
  confirmed. The mechanism is tested against a stand-in page that reports its own `window.innerWidth` (acceptance test X08, Linux,
  Electron 45.1, Xvfb): the page gets the width the table says, the zoom is put back at once after a navigation to another origin,
  and clicks, text selection, the wheel and the page's own Copy button still work while zoomed.
- **Windows and display scaling.** Nothing here was run on Windows. A one-off run on Linux with Chromium told the display is at 150
  percent (not part of the suite) gave the same pane widths in DIP and the same page widths in CSS pixels as at 100 percent (502 and
  717 in a 1280 DIP window), as the arithmetic above says. That is a proxy, not Windows.

## Manual check on Windows (about 10 minutes)

1. Open a project whose conversation has a writing block (ask ChatGPT for a short draft) and sign in if asked.
2. Make the window the size where the overlap was seen (1280 or 1440 wide, or your laptop at 125 or 150 percent scaling) and show
   both panes, ChatGPT beside Claude.
3. Settings, ChatGPT, Page size: choose **100%**. Look at the writing block. Do the floating navigation and overflow buttons sit on its
   text? Select a sentence, scroll, and copy the block as Markdown with ChatGPT's own Copy (paste into Notepad to check).
4. Choose **Automatic** and look at the same block, then do the same three things.
5. Repeat 3 and 4 with the sidebar open and collapsed, and in ChatGPT focus mode (the Split, ChatGPT, Claude control in the
   workspace bar set to ChatGPT, so ChatGPT fills the window).
6. Drag the divider slowly: the page should resize in small steps, without reloading, and a half-written message should stay.

What the results mean:

- 100 percent overlaps and Automatic does not: the hypothesis holds. Note the window size and scaling, so the 900 can be tuned.
- Both overlap in the split but not in focus mode: the width is the cause, and 70 percent is not enough at that pane width. Focus
  mode is the remedy there.
- It overlaps in focus mode too: the cause is not the pane's width, and this setting will not help.

Either way, `%APPDATA%\Mini-Summa\logs\main.log` has a `chatgpt page zoom` line (`factor`, `paneWidthDip`) each time the zoom changed,
which says what was in force.
