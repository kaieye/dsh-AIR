# dsh-air

`dsh-air` is a lightweight DSH web plugin for history recall, rich-draft editing, edit-aware branching, and BTW side conversations.

## Behavior

- Press `ArrowUp` on an empty composer to recall the newest complete, restorable draft.
- Keep pressing `ArrowUp` to move toward older messages.
- Press `ArrowDown` to move toward newer messages.
- Press `ArrowDown` past the newest message to clear the composer and stop navigating history.
- Do not intercept arrow keys while editing an ordinary non-empty draft.
- Continue navigating a recalled message only while its text is unchanged, the selection is collapsed, and the caret is at the beginning or end.
- Let DSH consume arrow keys first when slash-command or reference suggestions are active.
- Press `Ctrl+R` to open a reverse history search: type a query and the newest matching message is previewed immediately.
  - `Ctrl+R` or `ArrowUp` steps to the next older unique match; `Ctrl+S` or `ArrowDown` steps to the next newer unique match.
  - `Enter` accepts the previewed match as the editable draft; `Esc` (or `Ctrl+C`) restores the exact draft *and* caret you had before searching.
  - A `reverse-i-search:` status bar appears above the composer while searching: it shows your query, the highlighted match preview, a `1/N` match counter, and the `↑ older · ↓ newer · ⏎ accept · esc cancel` hints. A query with no match shows `no match` and keeps the search open.
  - Matching is case-insensitive, and repeated identical messages are folded within one search.
- Include user messages, steering messages, slash commands, and queued messages; restorable images, references, and large pastes are rebuilt with the draft.
- Fold consecutive exact duplicates only (append-only otherwise, like codex `history.jsonl`; the same text sent again later is a separate recall step).
- Sent history is persisted globally to browser localStorage (one shared store, like codex's `history.jsonl`), so `ArrowUp` recalls what you sent earlier **even in a brand-new conversation** and after a reload (capped at 500 entries by default; override with localStorage `dsh-air:history:limit` (10–5000). Clear recall storage in the console with `localStorage.removeItem('dsh-air:history:global')` and remove `dsh-air:drafts:*` keys, or call the exported clear helpers).
- Alignment notes: [`docs/history-global.md`](docs/history-global.md), [`docs/history-navigation-alignment.md`](docs/history-navigation-alignment.md).

## Composer UX Top 5

### 1. Large-paste chips

- The automatic large-paste fold capture is removed. Chips only appear when a folded paste reference is restored by **Fork and edit** or by history recall.
- Each chip can be **expanded or removed**. DSH's reference codec expands the exact payload before submission.
- Payloads are held in memory and browser localStorage so history recall can rebuild them.

### 2. Fork and edit an earlier prompt

- Sent user messages receive a **Fork and edit this prompt** action.
- The plugin forks at the last completed turn before that prompt, restores the original rich prompt into the child composer, and does **not** send it automatically.
- The first prompt has no earlier turn boundary, so the plugin attaches the fresh session to the **same workspace as the source** (falling back to creating in the same cwd when no workspace is accounted), then restores the draft — ensuring the new composer is directly editable instead of dropping into the workspace-picker home state.
- Unlike DSH's built-in **Branch into a new conversation** action (which only opens a child with an empty composer), this restores the selected prompt into the new composer for rewriting — the two complement each other.
- The branch target follows codex `app_backtrack` semantics:
  - a prompt belonging to a **turn still in progress** is rejected with a hint to wait for the turn to finish;
  - a prompt that is a mid-turn **steer** is rejected (DSH cannot split a turn mid-way); only a turn's initial prompt can be reopened independently;
  - on branch failure the original session stays selected and an error notice is shown, while the prompt is **restored into the original session's composer** (only when it is empty, to avoid clobbering an in-progress draft) for in-place rewriting; a child created before a restore failure is archived on a best-effort basis.

### 3. Rich draft history restoration

- `ArrowUp` / `ArrowDown` and `Ctrl+R` now recall versioned `DraftSnapshot` records instead of plain strings.
- A snapshot carries expanded text, durable image descriptors, live reference source/ref metadata, paste payloads, and stable message identity.
- Canceling reverse search restores the exact local draft, reference/paste chips, browser image IDs, and selection that existed before search.
- Historical images are resolved again through DSH's image service. If a resource is no longer available, the rest of the draft is preserved and a notice asks you to reselect it.

## BTW side conversation

BTW is the web implementation of a temporary side conversation. `/btw` and `/side` are aliases:

- Type `/btw` or `/side` and press `Enter` to open an empty BTW right sidebar.
- Add an inline question, such as `/side explain this`, to fork and ask immediately.
- BTW can start as soon as the main conversation contains a message. If the main reply is still generating, the plugin forks its latest completed prefix when available and carries the live tail into the first BTW prompt; if no turn has completed yet, it creates the child in the same workspace and supplies the current snapshot as reference context. The main reply is not stopped.
- Running `/btw` or `/side` again from the parent safely closes and replaces its existing BTW child. Follow-up questions belong in the right-hand native composer; a BTW child cannot recursively create another BTW.

On the web, BTW is shown in a docked right sidebar without replacing the globally selected DSH session:

- The main conversation remains selected and can continue running while BTW is open.
- The sidebar has no tab strip. Its only plugin-owned chrome is a close button in the upper-right corner, which safely ends the child and collapses the sidebar.
- The sidebar takes layout space instead of floating over the conversation. On desktop its left edge is resizable and the width is remembered; narrow screens switch to a full-width drawer.
- The Host's same native `conversation` slot tree used by the main pane fills the sidebar directly. Messages, reasoning, tool calls, approvals, status surfaces, queue controls, attachments, and the composer therefore use the same components and behavior on both sides.
- The compact header identifies BTW as a reference-only side conversation and reports the main-session state (including pending questions/approvals) plus the child lifecycle state.
- There is no `Ctrl+/` / `Ctrl+7` session switch and no **Open branch** / **Return to main** path. Interactions inside BTW remain in the right pane and do not change the globally selected main session.
- Native composer shortcuts such as `Esc` and `Ctrl+C` are left to the Host UI; BTW closes only through its explicit upper-right close button (or lifecycle cleanup).
- The fork inherits the main conversation as reference context, but only questions submitted after the BTW boundary are active instructions.
- BTW is intended for answers and lightweight, non-mutating exploration. Its boundary disables sub-agents and asks it not to modify files, git state, permissions, configuration, or the workspace unless you explicitly request a mutation inside BTW.

### Current web constraint

The public DSH client API creates BTW through an ordinary durable child session: a completed prefix uses `sessions.fork()`, while an interrupted first turn uses the runtime's session-create capability in the same workspace. The API does not expose an ephemeral fork or child deletion/unsubscribe. The plugin therefore sends the boundary with the first admitted child prompt, projects that envelope out of the Host's native session/input snapshots, and archives the child through `workspaces.archiveSession()` after safe cleanup. The host-owned session log still exists.

## Scope

Recall order still comes from one global localStorage history shared by all
conversations (default cap 500 entries; overridable via `dsh-air:history:limit`), while each source session stores
versioned rich-draft snapshots. The current transcript window, persisted
snapshots, and queue-to-durable handoff are merged by stable identity. Images
store only Host-provided durable descriptors and are resolved again on recall;
missing browser/Host resources produce a notice instead of dropping the rest
of the draft. Unknown semantic content blocks are still skipped as a whole to
avoid presenting a lossy projection as complete. Large-paste payloads also
live in localStorage, so clearing site data makes their chips unrecoverable.

## Install

Install the published package from npm:

```bash
dsh plugin --profile web add dsh-air
```

Restart DSH after installation. To remove the plugin:

```bash
dsh plugin --profile web remove dsh-air
```

## Update

Update to the latest npm release with:

```bash
dsh plugin --profile web update dsh-air --latest
```

Restart DSH after updating.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

History navigation and global ordering live in `src/core/history-navigation.ts` and `src/core/history-persistence.ts`; the rich draft model and storage live in `src/core/draft-snapshot.ts` and `src/core/draft-persistence.ts`, integrated by `src/client/HistoryKeyHandler.tsx`. Paste references and chips live in `src/core/paste-chip.ts`, `src/client/LargePasteController.ts`, and `src/client/RichComposerTools.tsx`. Fork editing lives in `src/core/fork-boundary.ts`, `src/client/ForkEditController.ts`, and `src/client/ForkEditEnhancer.tsx`. BTW boundary/native-snapshot logic and UI live in the corresponding `btw-*` core files plus `BtwController.ts`, `BtwNativeConversation.tsx`, and `BtwPanel.tsx`.
