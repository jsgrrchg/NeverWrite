import { invoke } from "../../app/runtime";
import {
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { isTerminalTab } from "../../app/store/editorTabs";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import type { FileTreeNoteDragDetail } from "../ai/dragEvents";
import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

export async function checkClaudeCodeInstalled(): Promise<boolean> {
    try {
        const result = await invoke<{ found: boolean }>(
            "devtools_check_binary",
            { name: "claude" },
        );
        return result.found;
    } catch {
        return false;
    }
}

// Milliseconds to wait for the terminal PTY to reach "running" state.
const TERMINAL_READY_TIMEOUT_MS = 10_000;
// Milliseconds to wait for Claude Code's TUI to initialise before pre-filling.
const CLAUDE_TUI_SETTLE_MS = 2_000;

// Quote a path for a Claude Code @mention. Use double quotes around any path
// that contains characters outside the safe unquoted set so the mention parser
// doesn't split on spaces, parens, brackets, etc.
function quoteForMention(path: string): string {
    return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `"${path}"`;
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
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            resolve(false);
        }, TERMINAL_READY_TIMEOUT_MS);

        const intervalId = setInterval(() => {
            const status =
                useTerminalRuntimeStore.getState().runtimesById[terminalId]
                    ?.snapshot.status;
            if (status === "running") {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(true);
            } else if (status === "error" || status === "exited") {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(false);
            }
        }, 100);
    });
}

export async function openClaudeCodeTerminalWithContext(
    detail?: FileTreeNoteDragDetail,
    paneId?: string,
): Promise<void> {
    const vaultPath = useVaultStore.getState().vaultPath;
    const tabId = useEditorStore
        .getState()
        .openTerminal({ cwd: vaultPath ?? undefined, paneId });
    if (!tabId) return;

    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (t) => t.id === tabId,
    );
    if (!tab || !isTerminalTab(tab)) return;

    const { terminalId } = tab;
    const ready = await waitForTerminalRunning(terminalId);
    if (!ready) return;

    const store = useTerminalRuntimeStore.getState();

    // cd into the target directory so the user can see where claude starts,
    // and so relative @mentions resolve correctly.
    const cdTarget = resolveCdTarget(detail, vaultPath);
    if (cdTarget) {
        // Single-quote the path so $, backticks, and backslash are inert.
        // Escape any embedded single quotes as '\'' (end-quote, literal, re-open).
        const cdQuoted = `'${cdTarget.replace(/'/g, "'\\''")}'`;
        await store.writeInput(terminalId, `cd ${cdQuoted}\n`);
    }

    // Build the claude command from settings.
    const {
        claudeCodeSkipPermissions,
        claudeCodeModel,
        claudeCodeContinueSession,
        claudeCodeMaxTurns,
    } = useSettingsStore.getState();

    const flags: string[] = [];
    if (claudeCodeSkipPermissions) flags.push("--dangerously-skip-permissions");
    if (claudeCodeModel.trim()) flags.push("--model", claudeCodeModel.trim());
    if (claudeCodeContinueSession) flags.push("--continue");
    if (claudeCodeMaxTurns > 0) flags.push("--max-turns", String(claudeCodeMaxTurns));

    const claudeCommand =
        flags.length > 0 ? `claude ${flags.join(" ")}\n` : "claude\n";
    await store.writeInput(terminalId, claudeCommand);

    if (!detail) return;

    const contextArgs = buildContextArgs(detail, vaultPath);
    if (!contextArgs) return;

    // Wait for Claude Code's TUI to finish initialising, then pre-fill the
    // input buffer with the @mentions so the user can complete their prompt.
    await new Promise<void>((resolve) => setTimeout(resolve, CLAUDE_TUI_SETTLE_MS));
    await store.writeInput(terminalId, contextArgs);
}
