# Terminal Follow-up Items

This page tracks terminal and Claude Code integration work that is still worth
doing after the first-class terminal rollout. It intentionally omits follow-ups
that have already landed, so this file can be used as a real backlog.

Resolved items from the original review:

- `checkClaudeCodeInstalled()` now uses a module-level cache in
  [`claudeCodeTerminal.ts`](../apps/desktop/src/features/terminal/claudeCodeTerminal.ts).
- `CLAUDE_TERMINAL_DESCRIPTOR` and `buildClaudeTerminalSetupStatus()` now live in
  [`claudeTerminalRuntime.ts`](../apps/desktop/src/features/ai/utils/claudeTerminalRuntime.ts).
- `waitForTerminalRunning()` now uses a Zustand subscription with a timeout and a
  visible console warning on failure.
- `CLAUDE_TUI_SETTLE_MS` was raised to `3_500` and documented as a heuristic.
- Claude Code is no longer auto-promoted to the default runtime just because a
  `claude` binary exists on `PATH`; explicit user/default runtime selection is
  preferred.

## 1. Detect Claude Code Readiness From Output

**What:** Claude Code prompt prefill still waits for a fixed TUI settle delay
before writing `@` mentions. This is intentionally conservative but imperfect:
cold starts can need more time, while warm starts wait longer than necessary.

**Better fix:** Watch terminal output for a stable Claude Code ready marker, then
inject the prefilled context as soon as the TUI is ready. Candidate signals might
include the prompt block or a stable hint line, but this depends on Claude Code's
output format staying stable across versions.

**Fallback:** Keep the fixed delay if no reliable marker exists. It is better to
be a little slow than to write context into a half-initialized TUI.

**Effort:** Medium.

## 2. Tighten Runtime Selection Semantics

**What:** `chatStore` now has `defaultRuntimeId` and `selectedRuntimeId`, but
`getDefaultNewChatRuntimeId()` can still fall back to `selectedRuntimeId` when no
explicit default is selectable. That keeps behavior forgiving, but it still lets
the current session influence the runtime for a new chat.

**Fix:** Decide whether new-chat runtime selection should be driven only by
`defaultRuntimeId` plus the implicit ACP fallback. If so, remove
`selectedRuntimeId` from `getDefaultNewChatRuntimeId()` and adjust tests and UI
copy around "current session runtime" vs "default for new chats".

**Effort:** Small to medium.

## 3. Surface Terminal Startup Failures In The UI

**What:** `waitForTerminalRunning()` logs a warning when startup times out, but
the user-facing failure path is still indirect. A timeout during Claude Code
launch should be obvious in the workspace, especially when a context action
opened the terminal automatically.

**Fix:** Route timeout/error state to the terminal tab or a toast so the user
knows the Claude Code startup action failed and can retry from the same context.

**Effort:** Small.

## 4. Review Claude Code Version Detection

**What:** The binary check verifies that `claude` exists, but does not validate
that it is the expected Claude Code CLI or that the version supports the flags
NeverWrite sends.

**Fix:** Consider a lightweight `claude --version` probe when diagnosing setup or
before enabling version-sensitive flags. Avoid doing this on every startup unless
the result is cached, because GUI app startup is already sensitive to shell
spawns.

**Effort:** Medium.

Last updated: June 1, 2026.
