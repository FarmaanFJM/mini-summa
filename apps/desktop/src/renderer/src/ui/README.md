# Design kit

Small, accessible building blocks for the Mini-Summa renderer. Import from the folder, never from a file inside it:

```ts
import { Button, IconButton, Dialog, ConfirmDialog, Menu, Select, Tabs, toast, Field, TextInput, Section, EmptyState } from '../../ui';
```

The kit follows the vendored Summa-UI principles (`third_party/summa-ui-guidance`). Where Mini-Summa differs on purpose, the reason is in
`docs/UI_PRINCIPLE_EXCEPTIONS.md`. The palette is defined once, in `../styles/mini-summa-tokens.css`: use tokens (`var(--s1)`, `var(--text-2)`),
never hex values.

## Components

| Component | Use it for | Rules that are built in |
| --- | --- | --- |
| `Button` | `variant`: `primary` (one per view, emerald), `secondary`, `ghost`, `destructive` (solid red, name the verb), `destructive-quiet` | `loading` keeps the label and ignores presses |
| `IconButton` | A control that is only an icon | `label` is required: it is the accessible name and the tooltip |
| `Dialog`, `ConfirmDialog` | One decision at a time. `ConfirmDialog` takes `confirmLabel` (a verb), `destructive`, `requireText`, `busy`, `error` | Focus is trapped and restored, Esc closes unless `busy`, `alertdialog` starts on Cancel, stacked dialogs only react at the top |
| `Menu` | Commands. Items: `label`, `icon`, `danger`, `checked` (+ `radio`), `shortcut`, separators, headings. `trigger` renders the opener, or pass `anchorPoint` for a context menu | Arrow keys, type-ahead, Esc returns focus to the opener |
| `Select` | A value from a list (search appears above 7 options) | Same keyboard model as `Menu`, works inside `Field` |
| `Field`, `TextInput`, `TextArea`, `Switch`, `Checkbox`, `Radio` | Forms. `Field` wires label, hint and error to its control | An error replaces the hint and is announced |
| `Tabs`, `tabPanelProps` | A row of views of one thing. Arrow keys, Home, End, Delete closes | The selected tab is a quiet fill, not an accent |
| `toast({ title, body?, action?, kind? })`, `<Toaster />` | Short confirmations and undo. One text action at most | Rendered once by the app; moves away from the native ChatGPT view |
| `Tooltip` | Describes a control that has no visible label | Shows on focus at once, on hover after a delay |
| `Section`, `EmptyState`, `Tag`, `Kbd`, `Spinner`, `Icon` | Layout and words. `EmptyState` is a sentence plus at most one action | `Tag` exists only as a functional control (`onClick`) |
| `SplitPane` | Two panes with a draggable, keyboard-operable divider (`ratio`, `only` to maximize one) | Ratio is clamped to 15 to 85 percent |
| `CopyButton` | Copy text through the desktop shell's clipboard, with a confirmation | |
| `Popover`, `computePosition` | Building blocks for your own floating UI | Placement avoids the native ChatGPT view when it can |

## The native ChatGPT view

The embedded ChatGPT page is a native layer drawn above all web content. A floating element that overlaps it would be hidden underneath.
Everything in the kit that floats (`Dialog`, `Menu`, `Select`, `Tooltip`, `Toaster`) already handles this: it moves away from the view
when there is room, and otherwise asks the host to hide the view while it is open (`useNativeOverlay`, reference counted, so
several overlays at once are fine). If you build your own floating element, call `useNativeOverlay(open)` while it is open.

## Using the app around the kit

```ts
import { useApi, useApp, useNative, useRoute, useUi } from '../../app/runtime';
```

- `useApp(selector)`: the data (projects, sessions, reports, deliveries, actions, activity, counts, settings, `connection`, `loaded`). It is
  a zustand store: select the smallest slice you need. `connection !== 'live'` means what you show may be out of date; dim live numbers
  with the `ms-live` class.
- `useApi().call('<route name>', { params, query, body })`: every core route, typed from `@minisumma/shared`. Errors are `ApiError`
  (`status`, `code`, `details`); show `error.message`.
- `useRoute()`: `view`, `projectId`, `section`, `reportId`, `deliveryId`, `activityId` and `go({ view, projectId, reportId, section, ... })`,
  `setView`, `selectProject`, `back()`. A notification click arrives as `go(target)`. State is remembered between runs: the selected project and view, each project's session tab and conversation, and the setup checklist's flags are kept in the core's settings (`ui`), so they survive the core taking another port (which changes the page origin and empties localStorage); localStorage stays as the fast local copy and the core's copy wins when both exist (`app/uiSync.ts`, `app/uiState.ts`).
- `useUi(selector)`: window-only state: `openProjectDialog({ mode: 'create' | 'edit', projectId })`, the session tabs.
- `useNative()`: clipboard, `shell.openExternal`, folder picker, ChatGPT view. Works in a browser too (`kind: 'browser'`).
- `app/selectors.ts`: `activeProjects`, `resolveProject`, `statsByProject`, `isAwaitingHandoff`, `needsAttention`.

### A view that needs its own navigation

A view never opens a second sidebar (P14). It replaces the sidebar content and shows a back chevron:

```tsx
import { SidebarContent } from '../shell/SidebarSlot';

<SidebarContent title="Settings" onBack={() => route.back()}>
  {sections.map((s) => <button key={s} className="sm-nav-item" onClick={() => route.go({ section: s })}>{s}</button>)}
</SidebarContent>
```

### Typing into Claude

`canOfferTyping(session)` (`features/workspace/sessionModel.ts`) says whether Mini-Summa may offer to type for the person (send a
prompt, answer a permission request). It is false for observed sessions, sessions that are not running, and a terminal that is still
starting (state `unknown`, labelled "Starting"): Claude Code's trust dialog defaults to "No, exit", so a blind Enter can end the session.
What the person types themselves in the terminal is never held back. The same goes for a running terminal whose conversation was
replaced (/clear, /resume) while the new session is not identified (`isReplacedUnidentified`: the view is live with a `termination`):
`noticeFor` shows the core's reason, `describeInputTarget` says `replaced`, and nothing offers to type for the person.

### A terminal that goes on as another session

When Claude replaces the conversation inside a managed terminal, the core keeps the terminal managed under a NEW session key and the old
session becomes ended history that names its successor (`SessionView.replacedBy`). `app/followSessions.ts` (started by the runtime) moves
the old session's tab to the new one in place (`replaceTab`), moves the project's remembered choice (so the core's `ui` copy and a restart
follow), and passes the keyboard on if the person was typing. The old session is listed in the Sessions menu ("Replaced inside their
terminal"); opening it there keeps it open as history (`ui.keepHistory`). Pure rules: `successorOf`, `replacementMoves` in
`features/workspace/tabs.ts`.

## Tests

`test/renderer/helpers.tsx` has `renderApp()` (the shell on the in-memory demo core), `createHarness`, `createFakeNative` and `FakeAdapter`
(a terminal that records what it was asked to do). Tests that render the shell stand in for views they do not own with
`test/renderer/stubViews.tsx`. Open `?demo=1` in a browser to use the demo core by hand
(`&scenario=empty|loading|error|offline`, `&native=none`, `&trust=1`).
