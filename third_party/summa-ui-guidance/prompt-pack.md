# Summa-UI design guidance (pack v0.1.0)

Follow these rules when producing or changing any user interface. They are defaults: break one only for a concrete usability reason and state the reason. Do not require any particular framework or library; the CSS tokens and class presets work with plain HTML.

## Principles

### P01 No Borders Within Borders
Do not place bordered elements inside other bordered elements.
- Express hierarchy with background elevation, spacing, typography and subtle section dividers.
- A border marks a meaningful boundary, not the existence of an element.
- Inputs and rows inside panels are filled surfaces, not outlined boxes.
- Exceptions: A single outline on a floating overlay (menu, dialog) is allowed. Checkbox and radio boxes need a visible boundary.

### P02 Dark Themes Move From Dark to Light
In dark themes each elevated surface is lighter than its parent.
- Page is darkest (--s0), main panels --s1, cards and inputs --s2, selected and raised --s3, overlays --s4.
- Never make a nested or elevated surface darker than its parent.
- Elevation should read without borders.
- Exceptions: A media lightbox backdrop may be darker than the page so the image dominates.

### P03 No Arbitrary Left-Border Decoration
Do not use a thicker left border to make an element stand out.
- Do not use a thick left border for cards, alerts, active items, info panels, categories or emphasis.
- Use fill, type weight or spacing for emphasis instead.
- Exceptions: The product or user explicitly requires it. It has an established semantic meaning in that interface (blockquote, diff gutter).

### P04 Tags Must Be Functional, Not Decorative
Tags exist only when users recognize, filter, group or interact with a category or state.
- Default tag: one background color, no border, optional icon, short text.
- Never create status tags for information that need not be shown (for example 'Automatically saved').
- Do not scatter tags to add visual variety.
- Exceptions: Label tags that filter or group tasks; a failure state that needs attention.

### P05 Information Must Earn Its Place
Show the minimum information needed for the current task.
- Do not explain familiar concepts because space is available.
- Prefer familiar patterns, clear naming, predictable position, progressive disclosure and contextual help over permanent explanation.
- A small learning curve beats permanent information overload.
- Exceptions: Legal or safety text that must be shown. A one-time first-use hint that can be dismissed.

### P06 Use as Few Colors as Possible
Color is a limited communication resource.
- Rely on neutral surfaces, typography, spacing, shape and hierarchy.
- Accent colors communicate meaning, interaction, identity or state.
- If removing a color does not reduce comprehension, remove it.
- Exceptions: Data visualisation, media imagery and market movement legitimately need hues.

### P07 One Visual Language
All Summa products share one design language.
- Share spacing logic, typography, surfaces, interaction states, iconography, corner treatment, controls, menus, navigation patterns and motion.
- Theme: matte, restrained, slightly glassy, reusable, consistent.
- Applications differ in content and workflow, not in design language.

### P08 Familiarity Is a Feature
Prefer established interaction conventions.
- Do not make users relearn dropdowns, menus, tabs, navigation, search, dialogs, selection, keyboard behavior or editor interactions.
- Innovate on workflow, not on controls users already understand.

### P09 Simplicity Beats Cleverness
Prefer the simpler design when two solve the problem.
- Do not add controls, containers, states, visual treatments or terminology without meaningful user value.
- Complexity requires justification; simplicity does not.

### P10 Minimalism Over Prevalence
Do not show every possible action at once.
- Prefer contextual and dynamic controls.
- Put 'Create' inside the dropdown where it becomes relevant, not beside it.
- Show Send before generation and Stop during it, never both.
- When a control turns into its opposite (Send to Stop), add an interaction guard against accidental double clicks.
- Exceptions: Two actions that can genuinely be used at the same moment may both be visible.

### P11 The Rectangle Rule
Organize information in clean rectangular regions.
- Do not use indentation as the primary hierarchy mechanism.
- Express hierarchy with typography, text color, weight, size and spacing; body content starts at the same left edge as its heading.
- Prefer flat lists, breadcrumbs and a single-level sidebar to indented trees.
- Exceptions: List marker gutters and table cell padding are not indentation.

### P12 Dividers Are Secondary Structure
Use subtle horizontal dividers only to support an existing hierarchy.
- Prefer spacing first.
- Add a divider only when spacing alone leaves two regions ambiguous.
- Avoid excessive divider lines.
- Exceptions: Repeated rows (feed posts, cart lines, review rows) may use one hairline each.

### P13 No Em Dashes
No em dashes in user-facing interface copy.
- Use commas, colons, periods, parentheses or a rewritten sentence.
- Applies to headings, descriptions, labels, notifications, empty states and demo content.
- Leave empty table cells empty instead of filling them with a dash.

### P14 No Sidebar Stacking
Never answer sidebar navigation with another full navigation sidebar beside it.
- Secondary context: replace the sidebar content with a back chevron, or split the sidebar into upper and lower regions, or use the primary content region for details.
- Editors, inspectors, order books and detail panels are content panes and are allowed.
- The rule targets redundant navigation structures only.
- Exceptions: Content panes (watchlist, filters, inspectors) are not navigation sidebars.

### P15 Monochromatic Selection and Focus
Ordinary selection, hover, focus and active navigation are neutral.
- Do not use the emerald accent for focus rings, selected cards, selected nav entries or text input outlines.
- Prefer neutral surface changes or neutral outlines.
- Keep accessible focus visibility.
- Keep semantic colors where they carry meaning (market movement, destructive actions).
- Use emerald sparingly: brand, the primary action of a view, meaningful state.
- Exceptions: Semantic colors for trading movement, KPI deltas and destructive actions.

### P16 Layout Diversity
No universal left-sidebar/right-content structure.
- Choose layout from the task, user expectations and information architecture.
- Support dashboards, public sites, feeds, dense data workspaces, catalogs and form-based experiences.
- Variety comes from the task, never from novelty; familiarity remains essential.

### P17 Subtle Focus and Selection
Neutral focus and selection must also be light in visual weight.
- Avoid thick, high-contrast or dominant outlines for ordinary input focus, selected content and active controls.
- Use 1px to 1.5px neutral rings and quiet fills.
- Keyboard focus indicators must still reach at least 3:1 contrast against their surface.
- Invisible focus is not tasteful minimalism.
- Exceptions: Windows high-contrast or forced-colors modes should use system focus styles.

### P18 Mobile Navigation Breathing Room
Do not compress navigation, headings, filters and actions into dense vertical stacks on mobile.
- Leave clear spacing between navigation and primary content.
- Do not trade readability and rhythm for more information above the fold.
- Scrolling is preferable to compression.
- Move secondary controls into a sheet or menu instead of stacking rows.

### P19 No Washed-Out Destructive Buttons
Destructive buttons are solid and readable, or neutral.
- Avoid translucent, low-contrast tinted ghost buttons, especially pale red text on dark red tint.
- Use a restrained solid destructive button with readable text, or a neutral treatment when appropriate.
- Do not rely on color alone: use a clear verb and an icon where helpful.
- Exceptions: Destructive menu items use danger-colored text plus an icon and sit last after a separator.

### P20 No Decorative Placeholder Identity
Do not invent avatars when no meaningful avatar exists.
- No circular initials, generated placeholder avatars or artificial profile-picture indicators by default.
- Plain names and relevant metadata are often enough.
- Introduce an avatar only when identity imagery helps distinguish entities or represents real content.
- Exceptions: Social platforms where users have real profile images.

### P21 Remove Before Adding
Meta-principle: when an interface feels unclear, subtract first.
- Ask whether something can be removed, merged, relocated, hidden contextually, represented through hierarchy or revealed only when needed before adding a component.

### P22 Exception Rule
Principles are defaults, not absolute prohibitions.
- A principle may be broken only for a concrete usability requirement, when the alternative interacts worse, deliberately, and with an explainable reason.
- 'Because it looks nicer' is not sufficient justification.
- Document every exception.

## Anti-patterns to avoid

### AP-001 Nested decorative borders [high, default]
Separate nested elements with background steps, spacing and type instead of drawing a border around each level.
- Problem: Every extra outline asks for attention. When a bordered container holds bordered cards, inputs and buttons, nothing is the boundary that matters and the interface turns into a grid of boxes.
- Instead: Elevation, not outlines
- Allowed when: A single outline around an overlay (menu, dialog, popover) is allowed: it separates floating content from whatever sits behind it. The content inside stays borderless.; Checkboxes, radios and similar controls whose shape must be perceivable may keep their own outline even inside a container (WCAG 1.4.11 asks for 3:1 non-text contrast). Prefer a fill step first and add the outline only when the fill cannot reach the contrast.; Data grids may draw cell dividers; use hairline dividers, not boxes, and not on every cell edge.
- Principles: P01, P02, P12

### AP-002 Thick arbitrary left borders [medium, default]
Do not use a thick left border to make cards, alerts or active items stand out; use a surface step, type weight or an icon.
- Problem: A 3 to 4px accent strip on one side is the most overused way to say "important" in generated UI. It carries no meaning of its own, clashes with rounded corners and is applied to everything.
- Instead: Surface and weight
- Allowed when: The product or the user explicitly requires it.; The stripe has an established semantic meaning in that interface, such as a blockquote rule, a diff gutter, a threaded reply line or a changed-line marker in an editor.
- Principles: P03

### AP-003 Washed-out destructive buttons [high, default]
Give destructive actions a solid, readable treatment with a clear verb, not pale red text on a translucent red tint.
- Problem: Low-contrast tinted ghost buttons fail contrast, look disabled and make the most consequential action the least legible one. They also lean on colour alone to signal danger.
- Instead: Solid destructive button; Neutral, confirm next
- Allowed when: A low-emphasis inline text action (for example "Remove" in a row, or a danger item in a menu) may use the danger text colour on an opaque surface if it meets 4.5:1 contrast and has a clear verb. The prohibited part is the translucent tinted fill with pale text.
- Principles: P19, P10

### AP-004 Excessive accent-colored outlines [medium, default]
Use neutral 1px focus rings and quiet fills for focus and selection; keep the accent for the primary action and meaning.
- Problem: Emerald rings on every input, emerald selected rows and emerald checkboxes make the whole product shout. When everything is accent coloured, the primary action and real status lose their signal.
- Instead: Neutral focus and quiet selection
- Allowed when: Semantic colour is allowed where it conveys information, such as a destructive field error or a trading gain.; If a neutral ring cannot reach 3:1 against an unusual surface (for example a bright image), a stronger ring is allowed there.
- Principles: P15, P17

### AP-005 Decorative tags and status pills [medium, default]
Show a tag only when users filter, group or act on it; drop it or write plain metadata for everything else.
- Problem: Rows of coloured, bordered pills turn information that needs no emphasis into visual noise. Status chips such as "Automatically saved" tell users nothing they can use.
- Instead: Plain metadata; Functional tag; Notification
- Allowed when: Tags are allowed when they are a functional filter, category or state that users recognise, filter or interact with (labels, issue status in a tracker, stock tickers).; A failure state that users must notice and fix (for example "Not saved") may use a tag or an inline indicator.
- Principles: P04, P05, P06

### AP-006 Fake placeholder avatars [low, default]
Do not draw circular initials or generated profile pictures when no real avatar exists; plain names and useful metadata are enough.
- Problem: Coloured initials circles pretend there is identity imagery when there is none. They add colour and width to every row, and make real avatars indistinguishable from fakes.
- Instead: Names and relevant metadata
- Allowed when: Real uploaded photos or logos that users recognise are allowed.; An avatar is allowed when imagery genuinely helps tell many similar entities apart (a social feed, a shared inbox with many senders) and it represents actual available content.; A deliberately chosen avatar (user picked a colour or icon) is user content, not a placeholder.
- Principles: P20, P05

### AP-007 Excessively dense mobile navigation [high, default]
On mobile, keep the top area to a title and a few icons, and move secondary controls into a sheet or menu instead of stacking rows above content.
- Problem: Header, tabs, filter chips and action buttons squeezed into 3 to 4px gaps leave a few lines of content and tiny tap targets. The interface feels anxious and is hard to use.
- Instead: Spacing and a filter sheet
- Allowed when: A dense, expert-use tool the user explicitly asked for (a trading terminal, a spreadsheet) may be compact if tap targets stay at least 24px and the density is a deliberate choice.
- Principles: P18

### AP-008 Multiple simultaneous opposing action buttons [medium, default]
Show only the control that applies in the current state; transform Send into Stop and guard against double clicks.
- Problem: Showing Send and Stop together forces users to work out which one is valid. One of them is always meaningless and invites wrong clicks.
- Instead: One control that changes
- Allowed when: Both actions may be shown when both can really be used at the same time (Accept and Reject on a review item, Undo and Redo, Zoom in and Zoom out, Play and Next).
- Principles: P10

### AP-009 Redundant Create buttons beside selection dropdowns [medium, default]
Put the Create action inside the dropdown (type a new name, then Create) instead of adding a button beside it.
- Problem: A permanent "Create label" button next to the label select exposes an action that is relevant only when the right label is missing. It also grows every form that has a select.
- Instead: Create inside the dropdown
- Allowed when: Creating the item needs a full form with several required fields, so a dialog launched from a menu entry is required.; A page whose purpose is managing the list itself (a labels settings page) needs its own Create button.
- Principles: P10, P08

### AP-010 Unnecessary explanatory copy [medium, contextual]
Remove helper text that explains familiar fields; keep copy that prevents a real error or consequence.
- Problem: A sentence under every field, or paragraphs in empty states, pushes content down, trains users to skip text and treats clear labels as insufficient.
- Instead: Labels carry the meaning; One-line empty state
- Allowed when: Copy that prevents a costly error, explains a non-obvious consequence (irreversible deletion, billing), or states a format that cannot be guessed is allowed.; Legal, compliance and first-run onboarding text that is required is allowed.; Error messages are never "unnecessary"; they must explain how to recover.
- Principles: P05, P21

### AP-011 Stacked navigation sidebars [high, default]
Replace the sidebar content and add a back chevron, or use the main region for details, instead of adding a second navigation sidebar.
- Problem: Two or three navigation columns side by side consume width, repeat structure and leave a sliver for content. Mobile has no good fallback for them.
- Instead: Swap sidebar content; Sections in content
- Allowed when: Content panes are not navigation sidebars: editors, inspectors, order books and detail panels are allowed.; A narrow icon rail for switching workspaces beside one list sidebar is an established pattern in some products; use it only when the product requires it and the rail has no second level of its own.
- Principles: P14

### AP-012 Excessive accent-color usage [high, default]
Limit the accent to brand identity, the primary action of a view and meaningful state; use neutrals for everything else.
- Problem: Emerald headings, links, nav, charts, tags and three primary buttons at once leave nothing that stands out. Colour no longer communicates.
- Instead: Neutral by default, accent by meaning
- Allowed when: A brand-led marketing page may use the accent more freely when the brand requires it.; Data visualisation may use hue to encode categories when neutrals cannot tell series apart.
- Principles: P06, P15

### AP-013 Decorative gradients and glow [medium, default]
Use matte flat surfaces; drop gradients, glows and gradient text unless they encode data or a brand asset.
- Problem: Multi-colour gradients, outer glows and gradient text are a generic signal of generated UI. They conflict with the matte, restrained language and age quickly.
- Instead: Matte surface
- Allowed when: Gradients that encode data (heatmaps, scales) are allowed.; Skeleton shimmer and subtle scrims for text legibility on imagery are allowed.; A brand illustration or marketing asset that the brand explicitly specifies is allowed.
- Principles: P06, P07

### AP-014 Indentation where flat rectangular organization works better [medium, contextual]
Show hierarchy with breadcrumbs, headings and typography in a flat list instead of indenting each level.
- Problem: Every level of indentation pushes the content edge further right and wastes width, and deep trees on small screens become unreadable.
- Instead: Breadcrumb and a flat list
- Allowed when: Content that is truly a deep tree users expect to browse and rearrange in place (a code editor file explorer, a document outline, threaded comments) may use indentation, because depth is the information.; Nested lists inside prose are allowed.
- Principles: P11

### AP-015 Repeated redundant card containers [medium, default]
Use one surface per group and flat rows inside it; do not wrap each level in another card.
- Problem: A card inside a card inside a card, each with its own radius and shadow, adds weight without meaning and makes the elevation order ambiguous.
- Instead: One surface, flat rows
- Allowed when: Each card in a grid of independent objects (a kanban card, a product tile) is a legitimate card when each is its own draggable or openable object.; A dialog or popover over a page is a separate layer, not a redundant card.
- Principles: P01, P09, P21

### AP-016 Excessive visible controls [medium, default]
Show the few frequent actions and move the rest into a menu or reveal them on hover and selection.
- Problem: A toolbar of a dozen always-visible icons makes every action equal, increases scanning time and breaks on narrow widths.
- Instead: Frequent plus menu; Context menu
- Allowed when: Dense editors and expert tools may keep a full formatting toolbar when users need one-click access, or when users arranged it themselves.; Keep every action reachable by keyboard and a menu, even when it is hidden.
- Principles: P10, P09

## Tokens

Use CSS custom properties from tokens.css. Roles:

- --s0 (surface): Page background. Darkest layer.
- --s1 (surface): Main panels and cards on the page.
- --s2 (surface): Inputs, hovered rows, nested cards on a panel.
- --s3 (surface): Raised controls, selected rows (neutral), dialogs.
- --s4 (surface): Menus, popovers, toasts, pressed states.
- --line (border): The only divider and hairline color.
- --line-strong (border): Single outline on floating overlays.
- --text (text): Primary text.
- --text-2 (text): Secondary text, headings that are muted.
- --text-3 (text): Tertiary text, placeholders, disabled.
- --accent (accent): Brand and the single primary action of a view. Not for focus or selection.
- --accent-hover (accent): Hover of the primary action.
- --accent-ink (accent): Text on accent fills.
- --accent-soft (accent): Meaningful state tint only (never ordinary selection).
- --accent-text (accent): Accent colored text for meaningful state (for example positive delta).
- --focus (state): Keyboard focus ring and input outline. Neutral, 1px to 1.5px, at least 3:1 contrast.
- --select (state): Selected row, card or item. Quiet neutral fill.
- --select-strong (state): Stronger neutral fill for pressed or range selection.
- --danger (semantic): Danger text and icons, destructive menu items, negative movement.
- --danger-soft (semantic): Subtle danger surface for non-button banners. Never for buttons.
- --danger-solid (semantic): Destructive button background (solid).
- --danger-solid-hover (semantic): Destructive button hover.
- --danger-ink (semantic): Text on destructive solid fills.
- --warn (semantic): Warning icons and amber data series.

## Presets

### preset.confirm-dialog Confirm dialog
Make the user pause before an action that is hard to undo or has significant consequences, and let them confirm or back out with certainty.
- Use when: Permanently deleting data without an undo (delete project, remove member, empty trash).; Actions with large or external consequences (publish to the public, send to 500 people, revoke access).; Discarding unsaved work the user cannot recover (leave with unsaved changes).; Irreversible high-impact actions that deserve type-to-confirm (delete workspace, delete account).
- Do not use when: Reversible actions. Do the action and offer Undo in a toast instead; a dialog for every delete trains users to click through.; Low-risk or frequent actions (archive, mark as read, remove from a list).; Asking for information or settings. That is a form dialog, not a confirmation.; Reporting results or errors. Use a toast or an inline message.; Stacking a confirmation on top of another confirmation.
- Variants: standard, destructive, type-to-confirm
- Avoids: AP-003, AP-008, AP-010, AP-016

### preset.context-menu Context menu
Offer the actions for the item under the pointer, using the familiar right-click, long-press and menu key conventions.
- Use when: Rows, cards, files, tabs or canvas objects that have several actions (rename, duplicate, share, delete).; Power users who expect right click, as an accelerator for actions that are also reachable elsewhere.; Touch: the same menu on long press (550ms).; An overflow (more) button menu that lists the same actions.
- Do not use when: As the only way to reach an action. Every action must also be reachable without right click (toolbar, overflow button, keyboard).; Menus with more than about 10 items. Group them, or move rarely used items elsewhere.; Replacing the browser menu on text, links or inputs where the native menu is what users expect.; Nested submenus more than one level deep.; A single action. Show the button directly.
- Variants: pointer, anchored, checkable
- Avoids: AP-001, AP-003, AP-016, AP-014

### preset.destructive-button Destructive button
Make destructive actions clearly distinguishable and readable without relying on colour alone, and without washed-out translucent red.
- Use when: The confirm button of a destructive confirm dialog (Delete project).; A dedicated danger zone action in settings (Delete account) that opens a confirmation.; A menu item that removes or deletes something (text colour plus icon, last in the menu).; A low-risk, undoable removal where a quiet neutral destructive style is enough (Remove from list).
- Do not use when: Ordinary, reversible actions such as Archive, Clear filters or Close. Use a neutral button.; As the main action of a view. The primary action is emerald; a destructive action is never primary.; Placed directly beside the primary button with the same emphasis. Pair a destructive button with a neutral Cancel instead.; More than one solid destructive button in the same view.; A pale red text on a translucent dark-red background (P19). That treatment is washed out and fails contrast.; An icon only red button with no label or accessible name.
- Variants: solid, neutral-destructive, menu-item, neutral
- Avoids: AP-003, AP-008, AP-012, AP-016

### preset.dropdown Dropdown (select)
Choose one or many options from a list, with creation of a missing option inside the list.
- Use when: Choosing from a known set of 3 to about 100 options (status, label, assignee).; Multi-select of labels or people, showing a count when more than one is chosen.; Choosing or creating an option in the same control (labels, tags, projects).; Compact forms and toolbars where radios would take too much space.
- Do not use when: Two options: use a switch, a checkbox or a segmented control.; Up to 4 options that matter at a glance: use radios or tabs so choices are visible.; Commands. A menu lists actions, a dropdown stores a value.; A separate Create button beside the dropdown (P10). Put Create inside the list.; A search field when there are 7 options or fewer.; Native select styling that breaks the shared menu look.
- Variants: single, searchable, creatable, multiple, quiet
- Avoids: AP-009, AP-016, AP-012, AP-001

### preset.empty-state Empty state
Tell the user why a region is empty and, if there is a sensible next step, offer exactly one.
- Use when: A list, table or board has no items yet (first use).; A search or filter returned nothing (no results).; A region could not load its data (error loading).; A task queue or inbox is cleared and the user is caught up.
- Do not use when: Anything with an illustration, mascot or decorative icon. Use words.; More than one action. Choose the one most users want; put others elsewhere.; Multi-paragraph explanations of how the product works (P05).; Instead of a loading state. Do not show an empty state before the data has loaded.; Tables where a blank cell is correct. Leave the cell empty, do not fill it with a dash or the word None.; Hiding the region entirely would be clearer than describing that it is empty.
- Variants: first-use, no-results, error-loading, caught-up
- Avoids: AP-010, AP-013, AP-015, AP-016

### preset.interaction-states Interaction states
One neutral, quiet vocabulary for focus, hover, selection, pressed, disabled and active navigation across every control.
- Use when: Styling any interactive element: buttons, rows, inputs, nav items, tabs, menu items.; Showing a selected row, card or list item.; Indicating the current page in navigation.; Reviewing a component for P15 and P17 compliance.
- Do not use when: Emerald focus rings, emerald selected rows or emerald input outlines (P15).; Thick or high-contrast outlines (2px and above, white outlines) for ordinary selection or focus (P17).; A frame, border or left bar to show selection. Selection is a quiet fill.; Removing the focus indicator (outline: none) without an equally visible replacement.; Distinct bespoke hover colours per component. Reuse the surface steps.
- Variants: focus-ring, hover, selected, pressed, disabled, active-nav
- Avoids: AP-002, AP-004, AP-012, AP-001

### preset.loading-state Loading state
Show that content is on its way without layout shift, flashing, or blocking the whole page.
- Use when: Skeleton rows while a list or table loads and the shape of the content is known.; An inline spinner on a button or next to a field while a short action runs (Saving, Checking availability).; A progress bar when the amount is known (upload, export, import).; A single quiet loading line (Loading) inside a small panel when the shape is unknown.
- Do not use when: Full-page spinners or blocking overlays. Keep the shell visible and load inside the region.; Loads that finish in under 200ms. Show nothing; a skeleton flash is worse than a short blank.; Indeterminate spinners for work whose progress you do know. Use determinate progress.; Skeletons that do not match the final layout, which cause shift when the data lands.; Decorative shimmer on content that is already present.; Announcing every refresh. Background refreshes should be silent.
- Variants: skeleton, inline-spinner, progress
- Avoids: AP-010, AP-013, AP-015

### preset.notification Notification (toast)
Tell the user that something happened outside their current focus, without interrupting them. A toast confirms a reversible or background event, or reports a failure that needs a recovery path.
- Use when: A reversible action finished and a one-tap Undo is useful (Conversation archived, Undo).; A background task completed or failed while the user is elsewhere (export ready, upload failed with Retry).; A system event the user did not trigger just now (connection lost, sync conflict, new version available).; A confirmation the user cannot otherwise see, such as Link copied or Moved to another project.
- Do not use when: The result is already visible in the UI: a created item appears in the list, a toggle flips, a tab changes. Do not also announce it.; Autosave. Never toast every save; at most show quiet saved state in context if users need it.; Validation errors. Show them inline next to the field, not in a toast.; Hover, navigation or selection changes. Nothing happened that needs reporting.; Errors the user must act on in context (a payment failed, a form cannot submit). Use an inline banner or a dialog, which stay put and can hold the fix.; Repeated progress ticks (3 of 40 imported). Use a progress indicator, and toast once at the end.; Success after a destructive confirmation where the UI already changed (the row is gone). The dialog and the disappearing row are the feedback.; Anything the user must read to proceed safely. Toasts disappear and can be missed; use a dialog or inline message.; Marketing, tips, upsells or unrelated news. Notifications are never mandatory and never promotional.
- Variants: compact, expanded, success, error, warning, info, neutral
- Avoids: AP-002, AP-004, AP-010, AP-012, AP-013, AP-016

## Icons

Use only the curated 165 icons (Lucide 1.62.0, ISC), 24px grid, stroke 1.75. Rules:

- Use only these icons. Never mix in another icon family or hand-drawn paths.
- One stroke weight everywhere: 1.75 on the 24px grid. Do not restyle per icon.
- Render at 14, 16, 18 or 20px. 16 is the default; use 20 for prominent controls.
- Pair the icon with a text label when the action is ambiguous or destructive.
- Icon-only controls need aria-label (and a title tooltip). Decorative icons need aria-hidden="true".
- Icons inherit currentColor. Do not tint icons for decoration; colour only for meaning (state, trading movement, destructive).
- Filled variants are for state only: play, pause, stop, active like or favourite. Never fill an icon for emphasis.
- Do not use an icon beside every label. If removing it loses no meaning, remove it.
- Need a new icon? Add it to the catalog from Lucide, with a stable Summa name; never rename an existing name.

Names: plus, minus, x, check, search, copy, clipboard, pencil, trash, refresh, undo, redo, download, upload, share, external, more-h, more-v, filter, sort, sliders, move, scissors, archive, save, send, zap, sparkle, maximize, minimize, expand, chevron-down, chevron-up, chevron-left, chevron-right, chevrons-left, chevrons-right, arrow-up, arrow-down, arrow-left, arrow-right, arrow-up-right, arrow-down-right, corner-down-left, menu, home, panel, compass, log-in, log-out, link, hash, at, info, circle-check, circle-x, circle-alert, warning, help, circle, circle-dot, circle-half, circle-dashed, loader, bell, bell-off, flag, ban, shield, eye, eye-off, lock, unlock, heart, star, thumbs-up, bold, italic, underline, strike, code, heading, quote, list, list-ordered, list-check, table, align-left, align-center, align-right, type, paperclip, mic, folder, folder-open, file, file-text, file-image, image, drive, cloud, inbox, play, pause, stop, skip-back, skip-forward, shuffle, repeat, volume, volume-off, music, film, message, message-plus, mail, phone, bookmark, repost, bag, cart, credit-card, truck, package, store, tag, trending-up, trending-down, dollar, wallet, candles, user, users, user-plus, settings, key, globe, map-pin, sun, moon, command, trophy, bar-chart, line-chart, pie-chart, activity, grid, rows, columns, layers, layout, sidebar-right, clock, calendar, history, timer, plane, bed, terminal, wifi, monitor, smartphone, bug, power, triangle-alert

## Checks

Objective checks an evaluator can run (see checks/rules.json):

- CHK-001 [objective, error] Bordered container inside bordered container (P01, P12)
- CHK-002 [objective, error] Thick left border on non-quote elements (P03)
- CHK-003 [objective, error] Translucent tinted destructive button (P19, P10)
- CHK-004 [objective, error] Accent color used for focus, selection or input outline (P15, P17)
- CHK-005 [heuristic, warning] Decorative pill tags and status pills (P04)
- CHK-006 [objective, error] Placeholder initials avatar (P20)
- CHK-007 [heuristic, warning] Excessive mobile vertical density (P18)
- CHK-008 [objective, error] Send and Stop visible together (P10)
- CHK-009 [heuristic, warning] Create button adjacent to a selection dropdown (P10, P08)
- CHK-010 [heuristic, warning] Unnecessary explanatory copy (P05)
- CHK-011 [objective, error] More than one navigation sidebar (P14, P16)
- CHK-012 [heuristic, warning] Accent color overuse (P06, P15)
- CHK-013 [objective, error] Decorative gradients and glow (P06, P07)
- CHK-014 [heuristic, warning] Indentation used for hierarchy (P11)
- CHK-015 [heuristic, warning] Redundant card containers (P09, P01)
- CHK-016 [heuristic, warning] Excessive visible controls (P10, P05, P18)
- CHK-017 [objective, error] Em dash in user-facing copy (P13)
- CHK-018 [objective, error] Keyboard focus indicator contrast (P17, P15)
- CHK-019 [objective, error] Destructive button text contrast (P19)
- CHK-020 [objective, error] Touch target effective hit area on mobile (P18)
- CHK-021 [objective, error] Horizontal overflow (P18)
- CHK-022 [objective, error] Focus outline removed without replacement (P17, P15)

Needs human judgment:

- HJ-001 Does the screen feel calm? Is anything competing for attention that should not?
- HJ-002 Is hierarchy readable without borders, using elevation, spacing and type?
- HJ-003 Do selection and focus read clearly but quietly (not dominant, not invisible)?
- HJ-004 On mobile, does the layout breathe, or does it feel compressed? Would more scrolling help?
- HJ-005 Does the layout suit the task and match user expectations for this kind of product?
- HJ-006 Are copy and labels natural, concise and free of needless explanation?
- HJ-007 Do destructive actions look serious and readable, and differ from neutral ones without relying on color alone?
- HJ-008 Does every identity element (avatar, initials, picture) represent real content?
- HJ-009 Do all screens feel like one product family (spacing, controls, corners, motion)?
- HJ-010 Are semantic colors (movement, error, success) used where meaning requires them and nowhere else?
