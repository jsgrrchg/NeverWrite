import { invoke } from "../../app/runtime";
import {
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { isTerminalTab } from "../../app/store/editorTabs";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { registerClaudeTerminalAgentSession } from "../ai/claudeTerminalAgentSession";
import type { FileTreeNoteDragDetail } from "../ai/dragEvents";
import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

// Module-level cache so chatStore, AIProvidersSettings, and TerminalSettings
// all share one shell spawn rather than each issuing their own.
let _binaryCheckCache: boolean | null = null;

export async function checkClaudeCodeInstalled(): Promise<boolean> {
    if (_binaryCheckCache !== null) return _binaryCheckCache;
    try {
        const result = await invoke<{ found: boolean }>(
            "devtools_check_binary",
            { name: "claude" },
        );
        _binaryCheckCache = result.found;
        return _binaryCheckCache;
    } catch {
        return false;
    }
}

export function resetClaudeCodeInstalledCacheForTests() {
    _binaryCheckCache = null;
}

// Milliseconds to wait for the terminal PTY to reach "running" state.
const TERMINAL_READY_TIMEOUT_MS = 10_000;
// Fixed delay waiting for Claude Code's TUI to finish initialising. This is a
// best-effort heuristic — a cold start (first auth, slow disk) can take longer.
// A proper fix would watch rawOutput for a stable ready marker, but that depends
// on Claude Code's output format staying stable across versions.
const CLAUDE_TUI_SETTLE_MS = 3_500;
const CLAUDE_CODE_TERMINAL_TITLE = "Claude Code";
const CLAUDE_CODE_TERMINAL_TITLE_PATTERN = /^Claude Code(?: (\d+))?$/;
const ALLOWED_CLAUDE_CODE_MODELS = new Set([
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
]);

function shellQuoteArg(arg: string): string {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
        return arg;
    }
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildShellCommand(args: string[]): string {
    return `${args.map(shellQuoteArg).join(" ")}\n`;
}

function getSafeClaudeCodeModel(model: string): string | null {
    const trimmed = model.trim();
    if (!trimmed) return null;
    if (ALLOWED_CLAUDE_CODE_MODELS.has(trimmed)) return trimmed;

    console.warn(
        `[terminal] Ignoring unsupported Claude Code model setting: ${JSON.stringify(trimmed)}`,
    );
    return null;
}

function getNextClaudeCodeTerminalTitle(): string {
    const maxExistingIndex = selectEditorWorkspaceTabs(
        useEditorStore.getState(),
    ).reduce((maxIndex, tab) => {
        if (!isTerminalTab(tab)) return maxIndex;

        const match = tab.title.trim().match(CLAUDE_CODE_TERMINAL_TITLE_PATTERN);
        if (!match) return maxIndex;

        const index = match[1] ? Number(match[1]) : 1;
        return Number.isFinite(index) ? Math.max(maxIndex, index) : maxIndex;
    }, 0);

    return `${CLAUDE_CODE_TERMINAL_TITLE} ${maxExistingIndex + 1}`;
}

// Quote a path for a Claude Code @mention. Use double quotes around any path
// that contains characters outside the safe unquoted set so the mention parser
// doesn't split on spaces, parens, brackets, etc.
function quoteForMention(path: string): string {
    return /^[A-Za-z0-9_./-]+$/.test(path) ? path : JSON.stringify(path);
}

// Strip the vault root prefix so @mentions are vault-relative rather than
// exposing absolute filesystem paths in the terminal input history.
function toVaultRelativePath(path: string, vaultPath: string | null): string {
    if (!vaultPath) return path;
    const prefix = vaultPath.endsWith("/") ? vaultPath : `${vaultPath}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function buildContextArgs(
    detail: FileTreeNoteDragDetail,
    vaultPath: string | null,
): string {
    // Notes and files only — folders aren't dereferenceable as file context.
    // detail.folder and detail.folders refer to the same entry; skip both to
    // avoid duplication (the cd already scopes the session to the folder).
    const paths: string[] = [
        ...detail.notes.map((n) => toVaultRelativePath(n.path, vaultPath)),
        ...(detail.files ?? []).map((f) =>
            toVaultRelativePath(f.filePath, vaultPath),
        ),
    ];
    return paths.map((p) => `@${quoteForMention(p)}`).join(" ");
}

// Determine the best directory to cd into for the given context.
// If exactly one folder is attached, cd into it; otherwise cd to vault root.
// Folder paths in the detail are vault-relative, so we join with vaultPath.
function resolveCdTarget(
    detail: FileTreeNoteDragDetail | undefined,
    vaultPath: string | null,
): string | null {
    // detail.folder is set only when exactly one folder is selected (see
    // FileTree.tsx handleAddChatTargetsToChat). detail.folders contains the
    // same entry — use the singular to avoid double-counting.
    if (detail?.folder && vaultPath) {
        return `${vaultPath}/${detail.folder.path}`;
    }
    return vaultPath;
}

function waitForTerminalRunning(terminalId: string): Promise<boolean> {
    return new Promise((resolve) => {
        const check = (): "ready" | "failed" | null => {
            const status =
                useTerminalRuntimeStore.getState().runtimesById[terminalId]
                    ?.snapshot.status;
            if (status === "running") return "ready";
            if (status === "error" || status === "exited") return "failed";
            return null;
        };

        // Check synchronously first to avoid missing a transition that
        // already happened between openTerminal() and subscribe().
        const immediate = check();
        if (immediate !== null) {
            resolve(immediate === "ready");
            return;
        }

        const deadline = setTimeout(() => {
            unsub();
            console.warn(
                `[terminal] Timed out waiting for terminal ${terminalId} to start`,
            );
            resolve(false);
        }, TERMINAL_READY_TIMEOUT_MS);

        const unsub = useTerminalRuntimeStore.subscribe(() => {
            const result = check();
            if (result !== null) {
                clearTimeout(deadline);
                unsub();
                resolve(result === "ready");
            }
        });
    });
}

export async function openClaudeCodeTerminalWithContext(
    detail?: FileTreeNoteDragDetail,
    paneId?: string,
): Promise<void> {
    const vaultPath = useVaultStore.getState().vaultPath;
    const tabId = useEditorStore
        .getState()
        .openTerminal({
            cwd: vaultPath ?? undefined,
            paneId,
            title: getNextClaudeCodeTerminalTitle(),
        });
    if (!tabId) return;

    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (t) => t.id === tabId,
    );
    if (!tab || !isTerminalTab(tab)) return;

    const { terminalId } = tab;
    const ready = await waitForTerminalRunning(terminalId);
    if (!ready) return;

    const store = useTerminalRuntimeStore.getState();

    // Build the claude command from settings. Treat persisted settings as data,
    // not trusted shell text, before writing into the interactive PTY.
    const {
        claudeCodeSkipPermissions,
        claudeCodeModel,
        claudeCodeContinueSession,
    } = useSettingsStore.getState();

    // Pin a fresh session id so we can locate this terminal's transcript exactly.
    // --session-id can't combine with --continue (which resumes an existing
    // session we can't name up front), so transcript-derived title/preview are
    // disabled in that case rather than guessed from another terminal's JSONL.
    const pinnedSessionId = claudeCodeContinueSession
        ? null
        : crypto.randomUUID();

    // claude runs in cdTarget after the cd below, so that's where it writes its
    // session transcript. Fall back to the vault / the terminal's spawn cwd.
    const cdTarget = resolveCdTarget(detail, vaultPath);
    const transcriptCwd = pinnedSessionId
        ? (cdTarget ??
          vaultPath ??
          store.runtimesById[terminalId]?.snapshot.cwd ??
          null)
        : null;

    // Surface this terminal in the Agents sidebar, with title (first prompt) and
    // preview (latest answer) sourced from the Claude Code transcript. The entry
    // is non-persisted and removed when the terminal tab closes.
    registerClaudeTerminalAgentSession({
        terminalId,
        title: tab.title,
        transcriptSessionId: pinnedSessionId,
        cwd: transcriptCwd,
    });

    // cd into the target directory so the user can see where claude starts,
    // and so relative @mentions resolve correctly.
    if (cdTarget) {
        // Single-quote the path so $, backticks, and backslash are inert.
        // Escape any embedded single quotes as '\'' (end-quote, literal, re-open).
        const cdQuoted = `'${cdTarget.replace(/'/g, "'\\''")}'`;
        await store.writeInput(terminalId, `cd ${cdQuoted}\n`);
    }

    const args = ["claude"];
    if (claudeCodeSkipPermissions) args.push("--dangerously-skip-permissions");
    if (pinnedSessionId) args.push("--session-id", pinnedSessionId);
    const safeModel = getSafeClaudeCodeModel(claudeCodeModel);
    if (safeModel) args.push("--model", safeModel);
    if (claudeCodeContinueSession) args.push("--continue");

    await store.writeInput(terminalId, buildShellCommand(args));

    if (!detail) return;

    const contextArgs = buildContextArgs(detail, vaultPath);
    if (!contextArgs) return;

    // Wait for Claude Code's TUI to finish initialising, then pre-fill the
    // input buffer with the @mentions so the user can complete their prompt.
    await new Promise<void>((resolve) => setTimeout(resolve, CLAUDE_TUI_SETTLE_MS));
    await store.writeInput(terminalId, contextArgs);
}
