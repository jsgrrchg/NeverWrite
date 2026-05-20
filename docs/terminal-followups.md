# Terminal Integration — Follow-up Items

From the Opus code review of `feature/terminal-first-class`. These are not blockers
for merge but should be addressed in follow-up PRs.

---

## 1. Cache the binary check — eliminate three redundant `sh` spawns

**What:** `checkClaudeCodeInstalled()` is called independently from three places:
`chatStore.initialize`, `AIProvidersSettings`, and `TerminalSettings`. Each spawns
`sh -lc 'command -v claude'` (~40–80ms on macOS). They can disagree mid-session and
waste 3× the startup time.

**Fix:** Add a module-level cache in `claudeCodeTerminal.ts`:

```ts
let _cached: boolean | null = null;

export async function checkClaudeCodeInstalled(): Promise<boolean> {
    if (_cached !== null) return _cached;
    try {
        const result = await invoke<{ found: boolean }>(
            "devtools_check_binary", { name: "claude" }
        );
        _cached = result.found;
        return _cached;
    } catch { return false; }
}
```

Additionally, `TerminalSettings` and `AIProvidersSettings` should read
`setupStatusByRuntimeId[CLAUDE_TERMINAL_RUNTIME_ID]?.binaryReady` from the chatStore
when the store is already initialized, rather than issuing their own IPC calls. The
module-level cache handles the cold path (settings opened before store finishes).

**Effort:** Small — 1–2 file changes.

---

## 2. De-duplicate `CLAUDE_TERMINAL_DESCRIPTOR` and setup status builder

**What:** The descriptor (`{ runtime: { id, name, description, capabilities }, ... }`)
and `buildClaudeTerminalSetupStatus` are inline in `chatStore.ts`. The message text
slightly diverges from what `AIProvidersSettings` builds locally. Same shape, two
sources.

**Fix:** Move both to a new `features/ai/utils/claudeTerminalRuntime.ts` file and
import from `chatStore.ts` and `AIProvidersSettings.tsx`. Unify the "not found" message
copy at the same time.

**Effort:** Small — 1 new file, 2 import updates.

---

## 3. Replace `waitForTerminalRunning` poll with Zustand subscribe

**What:** The function uses `setInterval(100ms)` + `setTimeout(10s)` to detect when
the PTY reaches `"running"` state. Polling introduces up to 100ms extra lag and is
stylistically wrong given Zustand's synchronous subscription API.

**Fix:**

```ts
function waitForTerminalRunning(terminalId: string): Promise<boolean> {
    return new Promise((resolve) => {
        const check = () => {
            const status =
                useTerminalRuntimeStore.getState().runtimesById[terminalId]
                    ?.snapshot.status;
            if (status === "running") return "ready";
            if (status === "error" || status === "exited") return "failed";
            return null;
        };

        // Synchronous check before subscribing — avoids missing events
        // that fired between openTerminal() and subscribe().
        const immediate = check();
        if (immediate) { resolve(immediate === "ready"); return; }

        const deadline = setTimeout(() => {
            unsub();
            resolve(false);
        }, TERMINAL_READY_TIMEOUT_MS);

        const unsub = useTerminalRuntimeStore.subscribe(() => {
            const result = check();
            if (result) {
                clearTimeout(deadline);
                unsub();
                resolve(result === "ready");
            }
        });
    });
}
```

Also: when the timeout fires (terminal never became ready), surface a visible error
rather than silently abandoning. A console.warn is the minimum; a toast or tab
error state is better.

**Effort:** Small — one function replacement.

---

## 4. Raise `CLAUDE_TUI_SETTLE_MS` and document the limitation

**What:** The 2-second fixed delay before pre-filling @mentions is a guess that's too
short on cold starts (slow disk, first auth) and wastes 1.6s on warm ones. The right
fix is detecting Claude Code's ready state from its output.

**Short-term fix:** Raise the constant to 3.5s and add a comment explaining why it
exists and what a proper fix would look like:

```ts
// Fixed delay waiting for Claude Code's TUI to finish initialising. This is a
// best-effort heuristic — a cold start (first auth, slow disk) may need more time.
// A proper fix would watch terminal rawOutput for a stable "ready" marker, or
// use a Claude Code CLI flag for initial prompt injection once one exists.
const CLAUDE_TUI_SETTLE_MS = 3_500;
```

**Long-term fix:** Watch `rawOutput` from the terminal session for a string that
reliably indicates Claude Code is ready for input (e.g., the presence of the `>`
prompt block or the "Try" hint line). This depends on Claude Code's output format
staying stable — flag it as a known fragility.

**Effort:** Trivial (constant bump) or Medium (output watching).

---

## 5. Persist the auto-selected default; verify it's actually Claude Code

**What:** When `claude` is found in PATH and no explicit preference exists, the app
auto-defaults to Claude Code each launch by re-running the binary check. Two problems:

1. If the binary becomes unavailable after first use, behavior changes silently on
   next launch.
2. A tool named `claude` that is not Claude Code would be auto-selected — unlikely
   but possible (e.g., a local script or AUR package).

**Fix:**

*Persistence:* When `claudeFound === true` and `persistedRuntimeId === null` in
`chatStore.initialize`, write the auto-selected default to `AiPreferences` just as
`setSelectedRuntime` would. This makes the choice stable and visible in Settings.

```ts
const defaultRuntimeId =
    persistedRuntimeId ??
    (claudeFound ? CLAUDE_TERMINAL_RUNTIME_ID : null) ??
    getDefaultRuntimeId(runtimes, setupStatusByRuntimeId);

// Persist auto-selection so it survives binary removal / reinstall cleanly.
if (!persistedRuntimeId && claudeFound && defaultRuntimeId === CLAUDE_TERMINAL_RUNTIME_ID) {
    saveAiPreferences({ defaultRuntimeId: CLAUDE_TERMINAL_RUNTIME_ID });
}
```

*Verification:* Run `claude --version` and check the output contains "Claude" or
matches a known version pattern before auto-selecting. This is a second shell spawn
on startup but prevents false positives. Can be skipped if the team decides the
risk is acceptable.

**Effort:** Small (persistence only) or Medium (persistence + version check).

---

## 6. Separate `selectedRuntimeId` from `userDefaultRuntimeId` in chatStore

**What:** `selectedRuntimeId` in the chatStore serves two conflated purposes:
- The runtime displayed in the chat header for the current session
- The user's default for new chats

This forced `getDefaultNewChatRuntimeId()` to reach around the store and read from
`AiPreferences` directly, because the active session's runtime was overwriting the
user's default in the second `set()` call inside `initialize()`.

**Fix:** Introduce `userDefaultRuntimeId: string | null` as a separate, first-class
store field:

- Set during `initialize()` (from persisted pref or auto-detection), never overridden
  by session restore
- Written via `setUserDefaultRuntime(id)` (which also persists to `AiPreferences`)
- Read directly in `handleAttachToNewChat`, `ai:new-agent`, and anywhere else that
  needs "what does the user want for new chats"
- `selectedRuntimeId` retains its existing role as the UI-visible "active session
  runtime" and is NOT persisted

`getDefaultNewChatRuntimeId()` can be deleted once this is in place. The AI Providers
"Default agent" dropdown would bind to `userDefaultRuntimeId`.

**Effort:** Medium — touches chatStore interface, initialize, setSelectedRuntime,
and 3–4 call sites. No new behaviour, pure refactor. Worth doing before the store
gets any larger.

---

## Sequencing

| # | Item | Effort | Priority | Blocks |
|---|---|---|---|---|
| 2 | De-duplicate descriptor | Small | Low | Nothing |
| 3 | Subscribe-based terminal ready | Small | Medium | Nothing |
| 1 | Cache binary check | Small | Medium | Informed by #6 |
| 4 | Raise settle delay | Trivial→Medium | Medium | Nothing |
| 5 | Persist auto-selection | Small | Medium | Nothing |
| 6 | Split selectedRuntimeId | Medium | High | #1 simplifies after |

Items 2, 3, 4, 5 can be done in any order in a single small PR.
Item 6 is the architectural cleanup — worth its own PR once the dust settles.
