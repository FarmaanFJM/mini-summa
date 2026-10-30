# UI principle exceptions

The renderer follows the vendored Summa-UI guidance (`third_party/summa-ui-guidance`, principles P01 to P22). The principles are
defaults (P22): each place where Mini-Summa differs from them is listed here with the reason. Anything not listed follows the
principle. The vendored bundle is read-only and is never edited; the differences live in code that loads after it.

## Owner decisions (not usability arguments)

### X1. Palette values come from the product owner, not from the vendored bundle

`apps/desktop/src/renderer/src/styles/mini-summa-tokens.css` is the only place the palette is defined. It loads after the bundle's
`tokens.css` and overrides its values. Token names are the bundle's, so every `sm-*` preset keeps working.

| Token | Bundle | Mini-Summa | Source |
| --- | --- | --- | --- |
| `--s0` page, terminal | #141515 | #0C0D0E | owner |
| `--s1` panels, sidebar, pane headers | #1b1c1c | #141618 | owner |
| `--s2` inputs, hovered rows | #232424 | #1A1D1F | derived (between s1 and s3) |
| `--s3` raised controls, selected rows, dialogs | #2c2d2d | #202326 | owner |
| `--s4` menus, popovers, pressed | #373838 | #272A2D | derived (s3 plus one step) |
| `--line` | rgba(255,255,255,.07) | #2B2E31, opaque | owner |
| `--text` | #ececeb | #ECEEEF | owner |
| `--text-2` | #a3a6a4 | #8D9298 | owner |
| `--text-3` | #6f7371 | #6F767D | derived, 3.9:1 on `--s1` and 3.1:1 on `--s4` |
| `--accent` | #10b981 | #10B981 | owner (same as the bundle) |

Still true: emerald is used only for the brand mark and the single primary action of a view; there is no lime, no gradient, and no
glow. The terminal palette (`--term-*`) is muted and keeps 4.5:1 or better on `--term-bg` for every colour except ANSI black, which is
used for fills.

### X2. Compact density

`--control-h-sm: 28px` and `--fs-md: 13px` make toolbars, tabs and the sidebar compact, as the owner asked. This is a desktop app;
P18 (mobile navigation breathing room) does not apply, and every control keeps a visible focus ring and an accessible name.

## Usability reasons

### X3. Structural hairlines between regions (P01, P02, P12)

P02 says elevation should read without borders. With the owner's darker values the steps between `--s0`, `--s1` and `--s3` are about
1.1:1, too small to separate the sidebar, the pane headers and the terminal on their own. So each region boundary has one 1px
`--line` hairline: right edge of the sidebar, under each pane header, the divider between the two panes. Hairlines are never nested
(no box inside a box), never decorative, and never on the left edge as an accent (P03). The only outline on a floating overlay is
`--line-strong`, as in the bundle.

### X4. Token names added beyond the bundle's

`--s5` (hover and pressed on `--s4` surfaces; the bundle's presets hard-code `#444545` there, which does not fit the owner's ladder),
`--term-*` (the terminal palette, font and metrics, read by `xtermAdapter`), `--control-h-sm`, `--fs-md`. No bundle token is renamed
or removed.

### X5. Status colours on dots and notices (P06)

Two non-neutral colours appear besides emerald: amber (`--warn`) for "needs your attention" and red (`--danger`) for an error. A person
looking at four projects has to see in one glance which one is waiting for them; neutral grey cannot do that. They are never the only
carrier: the dot always sits beside its words ("Waiting for your permission", "Ended with an error"), the sidebar marker has an
accessible name ("Needs your attention"), and the project row's accessible label repeats it. All other states (busy, idle, no process)
use neutral tones.

### X6. Persistent explanatory copy (P05, AP-010)

Four places carry sentences that a minimal interface would drop. Each states a fact that changes what the person does next:

- The line above every terminal: "Input goes to: GitManager / Session a1b2c3d4 (managed, Windows)", or "No input: ... is observed".
  Typing into the wrong session is the one mistake the app must make impossible to overlook.
- The observed-session panel ("Why you cannot type here"): without it a read-only terminal looks broken.
- The starting hint, after 6 seconds in "Starting": "Claude may be waiting for you to answer a question in the terminal, such as
  whether you trust this folder." Claude Code's trust dialog defaults to "No, exit", so Mini-Summa never types for the person while a
  terminal is starting (`canOfferTyping`), and without the hint a silent screen looks like a hang.
- Confirmation text that names consequences: removing a project also ends its running Claude terminals (they can be resumed later).

### X7. Terminal colours (P06, P07)

The 16 ANSI colours are program output, not interface chrome. Claude Code, compilers and test runners use red, green, yellow, blue,
magenta and cyan to mean things, and flattening them to one hue would remove information from the output. The palette is muted and
checked for contrast; it never leaks into the surrounding interface.

## Checked and not exceptions

- P14: there is exactly one sidebar. A view that needs its own navigation (settings) replaces the sidebar content and shows a back
  chevron (`SidebarContent`); the ChatGPT and Claude panes are content, not sidebars.
- P04: tags exist only as functional controls (filter or group buttons). Sessions show a state dot and words, not coloured pills.
- P20: no placeholder avatars or generated identity; a session is named by its short id, origin and environment.
- P19: destructive confirmations use a solid red button with a verb ("Delete project", "Stop session") and start with focus on Cancel.
- P13: no em dashes in user-facing copy (checked by search over `src/renderer`).
- The demo build draws a plain rectangle where the native ChatGPT view would be (`dev/demoNative.ts`). It is a test stand-in with its
  own colours, not product interface.

## Reports, activity, settings and onboarding

The four feature areas (`features/reports`, `features/activity`, `features/settings`, `features/onboarding`) follow the same rules. These
are the places where they differ from the principles, each with the reason.

### X8. A navigation column inside the view when the sidebar is only a rail (P14)

A view that needs its own navigation (the report queue, the settings sections) replaces the sidebar content and shows a back chevron.
When the sidebar is collapsed to its 52px rail there is no room for that content, so `SideNavigator` shows the same list, with the same
back chevron, as a column at the left edge of the view, beside the rail. It is still one list of places, never a second sidebar next to
an expanded one, and it goes back into the sidebar as soon as the sidebar is expanded. The column has one hairline on its right edge,
like the region boundaries in X3. The cleaner fix is in the shell (give a replaced sidebar its full width while a view holds it); the
column can be removed when that exists.

### X9. Explanatory sentences that state a fact the person decides on (P05, AP-010, extends X6)

Settings and the report handoff carry more sentences than a minimal interface would. Each one is there because leaving it out would
make a decision uninformed:

- Hooks: what installing changes and what it does not (only Mini-Summa's own entries, no repository file, sessions already running
  report only after a restart), next to the exact diff. This is the content of the consent.
- Handoff: that the declared status is a claim by the model and not proof, that the destination was fixed at capture, and that "I sent
  it" is the person's statement because Mini-Summa cannot see ChatGPT. Honest wording is the point of that screen.
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

- P01, P02: cards (one environment, one device) are one surface step above the page and hold plain rows; code blocks inside them fill
  with the next darker surface. No box has a border inside another box.
- P04: no tags. State is words with a small icon. The only buttons that look like tags are the report filters ("Waiting for handoff").
- P15: emerald marks one primary action per view or dialog ("Install hooks", "Save", "Import the key", "Send to Claude", "I sent it").
- P19: every destructive confirmation (revoke a device, remove the push key, remove old records, remove hooks) is a solid red button with
  a verb, a plain statement of what happens, and focus starting on Cancel.
- P13: no em dashes or en dashes in any copy or comment of these areas (checked by `test/renderer/features-copy.test.ts`).
- The pairing, push and Tailscale fixtures use made-up addresses on example domains only (also checked by that test).
