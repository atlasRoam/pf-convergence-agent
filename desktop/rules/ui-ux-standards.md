# PFSAA UI/UX Development Standards

> These standards apply to new components, interaction fixes, and visual adjustments in `apps/desktop/src/renderer`.
> They translate the high-priority rules from UI/UX Pro Max into constraints for PFSAA's desktop workspace.

## 1. Design Direction

PFSAA is a local developer tool, not a marketing page. The interface uses:

- A technical workspace layout with moderate information density.
- A clear primary/secondary hierarchy: sessions, conversation, execution progress, approvals, Provider/permission settings.
- Low-saturation neutral colors as the base; orange emphasizes danger/primary actions, green means success, amber means waiting, red means failure.
- SVG line icons; do not use Emoji as functional icons.
- Visual effects serve state expression; do not add animation to every element for decoration.

### 1.1 Semantic visual tokens

All Renderer surfaces and controls must use the semantic tokens declared in `styles.css`. Do not introduce a new literal color, shadow, radius, or control height when an existing token expresses the same role.

- Surfaces: `--canvas`, `--sidebar`, `--surface`, `--surface-raised`, `--surface-muted`, and `--surface-strong`.
- Text and borders: `--text`, `--muted`, `--faint`, `--line`, and `--line-strong`.
- State colors: `--accent`, `--green`, `--amber`, `--red`, and `--blue`. State color must still be paired with text, icon, shape, or status semantics.
- Compatibility aliases such as `--border` and `--text-primary` are legacy bridges only; new styles must use the canonical tokens above.
- Dark mode overrides belong in `.app-shell.dark, .overlay-root.dark`; component selectors must consume the semantic tokens rather than duplicating dark-mode literals.

### 1.2 Radius, elevation, and control sizing

Use this scale consistently so controls from the title bar, sidebar, composer, settings, and review drawer feel like one product:

| Role | Token | Value |
| --- | --- | --- |
| Micro badge / icon affordance | `--radius-xs` | 5px |
| Row / compact control | `--radius-sm` | 7px |
| Form and segmented control | `--radius-control` | 8px |
| Card / popover | `--radius-card` | 10px |
| Modal / dialog | `--radius-dialog` | 14px |
| Status pill | `--radius-pill` | 999px |

Control heights follow the same contract:

- `--control-height-compact` (28px) is for dense desktop toolbars and icon affordances.
- `--control-height` (32px) is the default button, chip, and row height.
- `--control-height-action` (36px) is for prominent actions and menu options.
- `--control-height-touch` (44px) is required for touch/mobile controls and must be used by mobile overrides.
- Review chrome uses `--review-file-header-height` (44px) for both the diff file header and file-list title, and `--review-toolbar-height` (40px) for both the diff viewbar and file filter. Keep these paired rows equal so the two review columns stay visually aligned.
- Selection states use `--selection-bg` for the active option and `--selection-bg-subtle` for the active row/open trigger. Keep the fill close to its surrounding surface so selection feels calm; use text weight, a check/icon marker, or the existing ARIA state as the secondary cue. `--selection-border` is reserved for cases where an outline is genuinely needed and must not become the primary accent for ordinary selection.

Use `--shadow-subtle` for hovered controls and lightweight grouped actions, `--shadow-control` for the composer and floating launchers, `--shadow-popover` for menus, and `--shadow` for dialogs or major panels. Selected controls may use the lower-contrast `--selection-control-shadow` when a little separation is needed. Overlay backdrops use `--overlay-scrim` (or `--overlay-scrim-subtle` for a drawer backdrop) and must have a dark-mode override.

### 1.3 Typography scale

Use the semantic type tokens declared in `styles.css` instead of introducing one-off font sizes:

| Role | Token | Value |
| --- | --- | --- |
| Compact metadata / dense code labels | `--font-size-compact` | 10px |
| Captions and secondary help | `--font-size-caption` | 11px |
| Labels and standard controls | `--font-size-label` | 12px |
| Body copy and primary row text | `--font-size-body` | 13px |
| Reading text and live thinking | `--font-size-reading` | 15px |
| Small headings | `--font-size-heading-sm` | 16px |
| Section headings | `--font-size-heading-md` | 19px |
| Page/dialog titles | `--font-size-title` / `--font-size-display` | 22px / 24px |

Code, terminal, and diff surfaces may use the compact monospace scale when legibility and column alignment require it. New UI copy should otherwise use one of these tokens and the matching `--line-height-*` token.

### 1.4 Component consistency rules

- `.button` is the baseline action style. Variants may change intent colors, but must retain the shared control height, radius, focus ring, and active-state feedback.
- Menus, suggestion popovers, context menus, and dialogs must use the shared radius/elevation tokens. Menu items need a visible hover and keyboard focus state; do not rely on hover to expose an important action.
- The model selector is intrinsic-width: `.composer-model-control` may shrink, while `.model-chip` uses `width: max-content` with a bounded `max-width`. Do not give it a fixed `width: 100%`, which creates unexplained blank space beside the model name.
- Review hunk navigation actions are a horizontal pair inside one compact segmented container on desktop. At mobile widths each action expands to the touch height while remaining a pair.
- Split diff colors are expressed through `--diff-split-*` tokens. Do not hard-code a second dark-only split palette in the component selector.
- Native checkbox/radio controls use the selection indicator color and must retain their checked state alongside a visible label; do not rely on a color-only custom replacement.
- Every stateful control needs hover, `:focus-visible`, disabled, and (where applicable) active/pressed styling. Focus must remain visible against both `--surface` and `--surface-muted`.
- Every selected/active state must combine at least two cues: a gentle visible fill plus an indicator such as a check icon, text weight, or `aria-pressed`/`aria-selected` semantics. Avoid inset shadows and accent-colored borders for ordinary selection; if a small depth cue is useful, use the low-contrast external `--selection-control-shadow`. The selected cue must remain distinguishable in both light and dark themes and must not depend on hover.
- Hierarchical project rows are an intentional exception: when a child session is selected, the parent project row stays transparent so the two levels do not visually merge. Preserve the project text weight and accent folder icon, and keep the normal hover background available.
- The desktop project sidebar supports a persisted collapsed rail at 64px. In the collapsed state keep New Task, collapse/expand, project, and runtime-status affordances reachable through icons with labels/tooltips; hide secondary labels and session lists only. Quick settings remain reachable from the header gear, while `Ctrl/Cmd + K` opens its AgentCore command-search child directly; neither belongs in the rail. The mobile drawer remains independently controlled by the top navigation button.

## 2. Accessibility (Highest Priority)

- Every icon button must have both `aria-label` and `title`.
- Every input must have a `label`, `aria-label`, or an associated description.
- Normal text contrast must reach at least WCAG 4.5:1; a disabled state must not be the only state information.
- All interactive elements must have a visible `:focus-visible` state.
- Modal, Drawer, and Command Palette must:
  - Focus the first interactive element when opened.
  - Trap Tab cycling within the overlay.
  - Close by layer on Escape.
  - Restore focus to the previously focused element on close.
- Provide a skip link to the main content.
- Dynamic status uses `role="status"`, `aria-live="polite"`, or `role="alert"`.
- Images must have meaningful `alt`; purely decorative images must also be handled explicitly.
- Do not use color as the only state expression; also provide differences in text, icon, shape, or animation.

## 3. Interaction and State

Every asynchronous operation has at least four states: `idle`, `loading`, `success/ready`, `error`.

- Show a skeleton, spinner, or explicit waiting copy when loading exceeds about 300ms.
- Disable repeated actions while submitting, authorizing, deleting, or switching permissions.
- Errors must appear near the related action and provide a retry or repair action.
- Approval requests must show tool name, arguments, risk state, and allow/deny actions.
- Switching sessions must not leak the old session's streaming messages, approvals, or running state into the new session.
- The session list uses a right-side spinner for running; awaiting approval uses a distinct warning state; do not stack meaningless status dots on the left.
- Important actions must be completable by click, not rely on hover alone; hover is only for supplementary information.

## 4. Command Input

- Normal text, `/command`, `/skill:name`, and `@file` must be distinguishable but not glaring.
- Slash highlighting may only apply to commands in AgentCore's dynamic command catalog, or to `/skill:*` that AgentCore explicitly supports; do not use "a `/` appears" as the condition.
- `/` inside paths, ratios, URLs, and normal sentences must not be treated as a command.
- Command suggestions must come from AgentCore Runtime; a static list is only a fallback when unavailable.
- After pasting images, show thumbnails above the input and allow removing them one by one; sending must work even with images but no text.
- The input's visual highlight layer must not break the native textarea's keyboard selection, caret, or scroll sync.
- Enter sends, Shift+Enter inserts a newline; shortcuts must not steal characters inside the input.

## 5. Conversation and Execution Progress

- User messages, Assistant replies, Thinking, Tool Call, and Tool Result have clear hierarchy.
- One `agent_start → agent_end/agent_settled` forms one execution group.
- An execution group shows only a summary by default: number of thinking segments, number of tool calls, and duration.
- When expanded, show tool name, arguments, results, and errors in chronological order.
- Tool Results must not be re-displayed as regular messages.
- Long arguments, results, and code must use `pre-wrap`, a max height, and independent scrolling; they must not break the conversation layout.
- Switching sessions jumps directly to the saved or latest position; do not play cross-session smooth-scroll animations.
- TaskId isolation, stable timeline items, restart restoration, and long-session constraints follow [Renderer session timeline and scrolling rules](renderer-session-timeline.md) (§1 and §3).

## 6. Animation and Performance

- Keep normal interaction animations at 150–300ms; animate only `transform` and `opacity`.
- Do not use continuous scroll listeners that cause expensive reflows.
- Implement `@media (prefers-reduced-motion: reduce)` to disable non-essential animations and scroll animations.
- Keep only a few meaningful dynamic states on screen: running spinner, loading skeleton, overlay entrance animation.
- Long sessions must bound the number of mounted rows by folding older messages behind a "show earlier" affordance; do not render thousands of messages unconditionally. Do **not** solve this with a virtual list — see [Renderer session timeline and scrolling rules](renderer-session-timeline.md) §4 for why measurement-based virtualization is incompatible with asynchronously sized rows.
- Do not add `contain` or `content-visibility` to timeline rows: they must be free to resolve their own height so native scroll anchoring can compensate.
- Images use thumbnails and constrained sizes; do not let user-pasted originals blow out the input or conversation area.
- Keep third-party Markdown rendering lazy-loaded so it does not block the first-paint workspace.

## 7. Responsive Layout

Acceptance widths include at least: 375, 560, 760, 1024, 1440px.

- Below 560px, hide non-core sidebars and keep primary actions in the conversation and input.
- Below 760px, the Inspector uses a drawer and must not squeeze the main conversation.
- Touch targets should be at least 44px; labeled desktop controls should be at least 32px and must have a keyboard-reachable path. Dense icon-only toolbar affordances may use `--control-height-compact` (28px) when they retain a visible focus state and do not hide the only path to the action.
- Popover, Tooltip, and Command Palette must not be clipped by a parent `overflow: hidden`.
- Any fixed overlay must avoid the input, Inspector, Toast, and system bounds.
- At 375–560px, the model selector must remain content-sized (with ellipsis when bounded) and must not reserve a large empty flex column; the review hunk actions must expand to `--control-height-touch`.
- At 560–760px, controls may hide secondary labels, but the primary action, model, queue mode, and close controls must remain discoverable and keyboard reachable.

## 8. Copy and Data Boundaries

- All visible zh/en copy lives in `packages/i18n/src/index.ts`; components read keys only (see AGENTS.md Code Boundaries).
- Copy should state the current state and the next action; avoid showing only "failed".
- Context usage, models, permissions, and Provider state shown in the UI must come from the AgentCore Bridge's real APIs.
- Do not disguise planned capabilities as supported; on failure, show an actionable error.

## 9. Checks Before and After Changes

### Before Development

When a UI/UX Pro Max skill is available, run its search with these queries to load relevant design-system and interaction constraints:

```bash
python3 "$UI_UX_PRO_MAX_SEARCH" "desktop developer tool React accessibility" --design-system -p PFSAA
python3 "$UI_UX_PRO_MAX_SEARCH" "focus modal keyboard loading motion" --domain ux
```

`$UI_UX_PRO_MAX_SEARCH` points at the skill's `scripts/search.py`; when the skill is not installed, rely on §1–§8 directly.

### Before Commit

- [ ] Running, awaiting approval, failure, empty state, and loading state all have clear visual feedback.
- [ ] The main flows are completable by keyboard; Modal focus can enter/exit/restore.
- [ ] Touch sizes, focus rings, contrast, and reduced-motion have been checked.
- [ ] Shared radius, elevation, control-height, overlay, and diff tokens are used; no new undefined `var(--...)` references or component-level dark palette literals were introduced.
- [ ] AgentCore Settings, Extension UI, menus, and the review drawer have been checked in both light and dark themes at desktop and mobile widths.
- [ ] Commands, Skills, and file references do not falsely highlight normal text.
- [ ] Images, long text, and long commands do not overflow in small windows.
- [ ] New IPC updates `packages/contracts` first.
- [ ] New copy is synced to both zh and en i18n.
- [ ] Structure or UI capability changes are synced to `docs/`.
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] `npm run test:renderer` passes and covers message order, turn grouping, stable keys, restart summaries, and long-session boundaries.
