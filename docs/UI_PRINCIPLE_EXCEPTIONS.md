# UI principle exceptions

The renderer follows the vendored Summa-UI guidance (`third_party/summa-ui-guidance`, principles P01 to P22). The principles are
defaults (P22): each place where Mini-Summa differs from them is listed here with the reason. Anything not listed follows the
principle. The vendored bundle is read-only and is never edited; the tokens are used as they are, and the few differences live in code
that loads after them.

## Owner decisions and the palette

### X1. The palette is the bundle's, with no override

Until round 3 Mini-Summa overrode the bundle's surfaces, lines, text and select colours with the owner's own values
(`#0C0D0E` page, `#141618` panel, and so on). That override is gone. `third_party/summa-ui-guidance/css/tokens.css` is the source of
truth for surfaces (`--s0` to `--s4`), lines, text, accent, focus, select, danger, warn, radius, spacing, type scale and shadow, and
`apps/desktop/src/renderer/src/styles/mini-summa-tokens.css` overrides none of them. It holds only what the bundle has no token for
(X4). The window and the native ChatGPT view already used the bundle's page colour (`#141515`, `src/main`).

What this means for the checks (computed with WCAG relative luminance on the real values; the in-page check below measures the same
on the rendered text):

| Pair | Ratio |
| --- | --- |
| Each surface step, dark to light: `--s0` to `--s1`, `--s2`, `--s3`, `--s4`, `--s5` | 1.07, 1.10, 1.13, 1.17, 1.22 per step, always lighter (P02) |
| `--text` on `--s0` to `--s4` | 15.5, 14.5, 13.2, 11.7, 10.0 |
| `--text-2` on `--s0` to `--s4` | 7.5, 7.0, 6.3, 5.6, 4.8 (3.9 on `--s5`, the hover step of a menu) |
| `--text-3` on `--s0` to `--s4` | 3.8, 3.6, 3.2, 2.9, 2.5 |
| Focus ring (`--focus` over the surface) on `--s0` to `--s4` | 4.7, 4.6, 4.4, 4.2, 3.8 (needs 3) |
| `--accent-ink` on `--accent`, `--danger-ink` on `--danger-solid` | 6.2, 5.1 (6.1 on hover) |

So text a person has to read uses `--text` or `--text-2`. `--text-3` fails 4.5:1 on every surface and is used for placeholders,
disabled controls and decoration only (there is no word set in it anywhere in the shell, the views or the kit; the browser check below
would flag one). A checkbox or radio ring is `--text-2`, not the bundle's `--text-3`, so it keeps 3:1 on a dialog (`--text-3` gives 2.9:1
on `--s3`). The sidebar count is `--text-2` in a smaller size, not `--text-3` as in the reference.

Evidence of the rendered result (demo build in Chromium, the Summa-UI reference checks from `scripts/lib/collector.mjs` plus a
contrast and surface-order pass over every text node): the shell, the sidebar, the quick switcher, Activity, Reports and Settings (every
section) show no nested border or ring (CHK-001), no left border (CHK-002), no tinted destructive button (CHK-003, CHK-019), no
gradient or glow (CHK-013), no em dash (CHK-017) and no horizontal overflow (CHK-021) at 1440x900, 960x600 and 900x1200; every text node
there is at least 4.5:1 on its real, composited surface; and 149 keyboard focus stops were walked, each with a neutral ring of 1.5px or
less at 3:1 or better.

### X2. Compact controls (P18)

The bundle's controls are 32px (`--control-h`) and 40px. Toolbars, tab strips, filters and the pane headers use `--control-h-sm`
(28px, the size of the bundle's own `.sm-icon-btn--sm`), because two panes and their headers share a window that can be 960px wide. This
is a desktop application; P18 (mobile navigation breathing room) does not apply, targets stay at 28px or more, and every control keeps a
visible focus ring and an accessible name. The owner's earlier 13px body size (`--fs-md`) is retired: the type scale is the bundle's
(`--fs` 14px for body text, `--fs-sm` 12.5px for dense and secondary text).

## Usability reasons

### X3. One hairline: the pane divider (P12)

With the bundle's palette the sidebar needs no line against the panel: it sits on the page (`--s0`) with no border, and the content is
one inset, rounded `--s1` panel (the reference `AppShell`), so the step of surface is the boundary. The only line left in the shell is
the divider between the ChatGPT and Claude panes. It is the drag handle first (a 1px `--line` hairline at rest, `--line-strong` under
the pointer, the focus ring on the keyboard) and it is never nested: no box inside a box, no accent, never on the left edge (P03). The
only outline on a floating overlay is `--line-strong`, as in the bundle.

### X4. Tokens added beyond the bundle's

`styles/mini-summa-tokens.css` adds three things, and no bundle token is renamed, removed or given another value:

- `--s5` (`#444545`): one step beyond `--s4`, for hover and pressed on menu, dialog and tooltip surfaces. The bundle's presets hard-code
  this value; here it has a name.
- `--control-h-sm` (28px): the compact control of X2.
- `--term-*`: the terminal's palette, font and metrics, read by `xtermAdapter` when a terminal is created. `--term-bg` is `--s1`, the
  panel's surface, so the terminal reads as part of the panel and not as a darker hole in it (P02). The neutrals follow the bundle's text
  colours; ANSI black is `--s3` and is a fill, never text; every other colour, bright black included, keeps 4.5:1 or better on `--s1`
  (computed: red 5.5, green 7.2, yellow 8.7, blue 6.4, magenta 6.6, cyan 7.9, white 10.1, bright black 4.9).

### X5. Status colours on dots and notices (P06)

Two non-neutral colours appear besides emerald: amber (`--warn`) for "needs your attention" and red (`--danger`) for an error. A person
looking at four projects has to see in one glance which one is waiting for them; neutral grey cannot do that. They are never the only
carrier: the dot always sits beside its words ("Waiting for your permission", "Ended with an error"), the sidebar marker has an
accessible name ("Needs your attention"), and the project row's accessible label repeats it. The same dot is on the quick switcher's
rows and, while the sidebar is collapsed, on the edge tab that opens it (its accessible description says why). All other states (busy,
idle, no process) use neutral tones.

### X6. Persistent explanatory copy (P05, AP-010)

Four places carry sentences that a minimal interface would drop. Each states a fact that changes what the person does next:

- The line above every terminal: "Input goes to: GitManager / Session a1b2c3d4 (managed, Windows)", or "No input: ... is observed".
  Typing into the wrong session is the one mistake the app must make impossible to overlook. For a running terminal whose conversation
  was replaced (/clear, /resume) and whose new session Mini-Summa has not identified, the line and the notice under it say so in the
  core's own words ("Mini-Summa will not type into it for you"): what the person types in the terminal still arrives, and nothing else
  may.
- The observed-session panel ("Why you cannot type here"): without it a read-only terminal looks broken.
- The starting hint, after 6 seconds in "Starting": "Claude may be waiting for you to answer a question in the terminal, such as
  whether you trust this folder." Claude Code's trust dialog defaults to "No, exit", so Mini-Summa never types for the person while a
  terminal is starting (`canOfferTyping`), and without the hint a silent screen looks like a hang.
- Confirmation text that names consequences: removing a project also ends its running Claude terminals (they can be resumed later).

### X7. Terminal colours (P06, P07)

The 16 ANSI colours are program output, not interface chrome. Claude Code, compilers and test runners use red, green, yellow, blue,
magenta and cyan to mean things, and flattening them to one hue would remove information from the output. The palette is muted and
checked for contrast on `--term-bg` (X4); it never leaks into the surrounding interface.

## Shell, sidebar and quick switcher (round 3)

### X13. The quick switcher draws no title (P05, the kit's rule that a dialog is titled)

The quick switcher is a palette: a filter field and a list. Its dialog is named "Switch project" for assistive technology (an `h2` that
is present and not drawn, `hideTitle`) and the field says what it is for ("Switch to a project"). A drawn heading over a search field would
be words that say nothing the field does not. Every other dialog keeps its visible title. It is a modal dialog like the others: focus is
trapped and restored, Esc closes it, the page behind is inert, and the native ChatGPT view steps aside.

### X14. The checkbox and radio ring is `--text-2` (P01 allows the outline; the bundle's value fails 3:1 on a dialog)

See X1. This is a deviation from the bundle's preset CSS (`--text-3`), not from a principle: the ring is the one outline a control may
have, and it has to be perceivable.

## Checked and not exceptions

- P14: there is exactly one sidebar and never a second column. A view that needs its own navigation (Settings, Reports) replaces the
  sidebar content and shows a back chevron (`SidebarContent`). While such a view holds the sidebar it is on screen even if the person
  collapsed it, and the person's choice returns when the view lets go (`sidebarShown`). The ChatGPT and Claude panes are content, not
  sidebars. (Round 3 removed the old X8, a column inside the view when the sidebar was a rail.)
- P04: tags exist only as functional controls (filter or group buttons). Sessions show a state dot and words, not coloured pills.
- P20: no placeholder avatars or generated identity; a session is named by its short id, origin and environment, and a project by its name
  (no initials, no circles, no folder icon per project; a dot only when a session waits).
- P19: destructive confirmations use a solid red button with a verb ("Delete project", "Stop session") and start with focus on Cancel.
- P13: no em dashes in user-facing copy. `test/renderer/copy-no-em-dash.test.ts` scans every string, markup text and CSS content of
  `src/renderer`, `src/main` and `src/preload` and fails with the file and line (comments may keep one).
- P15, P17: selected is the quiet `--select` fill (rows) or `--s3` (active navigation, a toggled-on icon button); focus is a 1.5px
  `--focus` ring (a 1px ring on text inputs); neither uses the accent. Emerald is the brand mark and the one primary action of a view.
- The demo build draws a plain rectangle where the native ChatGPT view would be (`dev/demoNative.ts`). It is a test stand-in with its
  own colours, not product interface.

## Reports, activity, settings and onboarding

The four feature areas (`features/reports`, `features/activity`, `features/settings`, `features/onboarding`) follow the same rules. These
are the places where they differ from the principles, each with the reason.

### X9. Explanatory sentences that state a fact the person decides on (P05, AP-010, extends X6)

Settings and the report handoff carry more sentences than a minimal interface would. Each one is there because leaving it out would
make a decision uninformed:

- Hooks: what installing changes and what it does not (only Mini-Summa's own entries, no repository file, sessions already running
  report only after a restart), next to the exact diff. This is the content of the consent.
- Handoff: that the declared status is a claim by the model and not proof, that the destination was fixed at capture, and that "I sent
  it" is the person's statement because Mini-Summa cannot see ChatGPT. Honest wording is the point of that screen. The handoff strip
  in the workspace (`features/reports/HandoffStrip.tsx`) repeats the one sentence that matters while the person is pasting into
  ChatGPT, "It is not marked as sent until you press I sent it.", and names where the report goes. Without them the strip would be a
  button that looks like it sends.
- Push, remote access, data and privacy: what a push contains and that the PC must be awake to send it, what Tailscale Serve exposes
  and that Funnel is never used, what is stored and where. These say what leaves the PC and what does not.
- Tailscale's own explanation (`problem`) is shown word for word, never summarised, because it names the exact command or page that
  fixes it.

### X10. Tint on added and removed lines of a diff (P06)

In the hooks diff, added lines have a faint green background and removed lines a faint red one (the terminal palette at 14 percent).
The `+` and `-` are written in the text of every line, so colour is never the only carrier; the tint only makes a 50 line change
scannable. Nothing else in these screens uses green or red for meaning except the words on the error and warning notices.

### X11. A white block for the pairing QR code (P02, P06)

The QR code is drawn black on white with its quiet zone, whatever the theme. Cameras read dark on light, and inverted codes fail on
many phones. It is the only light surface in the application, it appears only while a pairing code is valid, and it is removed from the
page when the code expires. The same code is also written out as text (offer id and code) for a phone that cannot scan.

### X12. A setup checklist that floats over the application (P14, "never block")

First run shows a checklist over the empty application. It is a panel, not a dialog: no backdrop, nothing behind it is inert, it can be
hidden, and Settings (About and setup) brings it back. It uses the outline and shadow of other floating surfaces (X3). Once a project
exists it shrinks to one small button in the corner so it never covers a terminal, and it removes itself when every step that matters
is done.

## Checked and not exceptions (these four areas)

- The handoff strip (the band above the two panes while a report of the selected project waits for the person): P15, one main action per
  view: the strip's button is the main action, and while it is shown an empty Claude pane offers "Start a session" as a secondary
  button instead of a second emerald one. P01, P02: the band is one surface step above the panes (the fill other notices use) with the
  one hairline that every region boundary has (X3), no box inside it, no accent edge (P03). P13: no dashes in its copy. P06: a warning
  or an error line uses the same two status colours as the handoff card, always with its words. It is in the page, not floating, so the
  native ChatGPT view is laid out below it and needs no overlay handling (the kit's rule for floating UI does not apply). A long title
  is cut at two lines and whole in the tooltip and the accessible name; the buttons wrap under the text in a narrow window instead of
  shrinking.

- P01, P02: cards (one environment, one device) are one surface step above the page and hold plain rows; code blocks inside them fill
  with the next darker surface. No box has a border inside another box.
- P04: no tags. State is words with a small icon. The only buttons that look like tags are the report filters ("Waiting for handoff").
- P15: emerald marks one primary action per view or dialog ("Install hooks", "Save", "Import the key", "Send to Claude", "I sent it").
- P19: every destructive confirmation (revoke a device, remove the push key, remove old records, remove hooks) is a solid red button with
  a verb, a plain statement of what happens, and focus starting on Cancel.
- P13: no em dashes or en dashes in any copy or comment of these areas (checked by `test/renderer/features-copy.test.ts`).
- The pairing, push and Tailscale fixtures use made-up addresses on example domains only (also checked by that test).

## Project dialogs (round 3)

New project and a project's settings (`features/projects`) make no exception to a principle. These are the places a reader might expect one,
with why none is needed.

- P04, AP-005: settings are applied at once, and each change is confirmed by the word "Saved" beside the section heading for about two
  seconds. It is plain text in a status region, with no background and no border, and it goes away by itself; it is not a tag, and not a
  toast (the notification preset says "at most show quiet saved state in context"). A refusal by the core is written in words beside the
  field and stays until the next attempt.
- P05, AP-010: under the ChatGPT Project address, "Only the address is saved. Nothing in the project is imported or synced." stays on
  screen. AP-010 allows copy that prevents a wrong assumption: without it a person would reasonably expect the project's files and
  conversations to appear in Mini-Summa. It is the only explanatory sentence in either dialog. The live readings under a field ("Title:
  Caissa trainer", "Will be saved as acme/billing", the folder's environment) say what the typed text will do and appear only while
  something is typed.
- P01, P02: the source selector is a filled segmented control (track `--s4`, chosen segment `--s5`) on the dialog's `--s3`. The folder and
  conversation rows are `--s4` with their inputs one step lighter. The only outlines are the dialog's own, the radio's ring (allowed), and
  the 1px red ring of a field that has a refusal beside it (a semantic colour, always with its words).
- P10: controls that do not apply are not drawn: "Open on GitHub" only when a repository is saved, Browse only where the host has a folder
  picker, "Change" only while the address is not being changed. A project with no folder shows no sentence about it, only the way to add one.
- P12: the sections of the settings are separated by space, with no divider line.
- P21: "New sessions start in", the Save and Cancel buttons of the old edit dialog, and the draft are gone. Which folder (and so which
  environment) a session starts in is asked when a session starts.
