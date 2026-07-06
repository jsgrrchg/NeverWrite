import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    normalizeVaultPath,
    resolveVaultAbsolutePath,
    toVaultRelativePath,
} from "../../app/utils/vaultPaths";
import { openAiEditedFileByAbsolutePath } from "../ai/chatFileNavigation";

/**
 * Collapse `.` and `..` segments so the vault-boundary check below cannot be
 * fooled by traversal like `../secret.txt` (which would otherwise keep the
 * `/vault/` prefix and slip past a plain string comparison).
 */
function collapseTraversal(path: string): string {
    const normalized = normalizeVaultPath(path);
    const isAbsolute = normalized.startsWith("/");
    const out: string[] = [];
    for (const segment of normalized.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    return (isAbsolute ? "/" : "") + out.join("/");
}

export interface DeepLinkOpenFilePayload {
    path: string;
    line: number | null;
    endLine: number | null;
}

export type DeepLinkOpenResult =
    | "opened"
    | "invalid"
    | "no-vault"
    | "outside-vault"
    | "not-found";

/**
 * Resolve a `neverwrite://open?path=...` deep link against the open vault and
 * open the file if it is a legitimate vault member.
 *
 * Security boundary (see issue #289): this only opens or reveals an existing
 * file inside the current vault. Absolute paths are accepted only when they
 * resolve inside the vault root; relative paths resolve against that root.
 * No writes, no shell/open-external behavior.
 */
export async function openDeepLinkFile(
    payload: DeepLinkOpenFilePayload,
): Promise<DeepLinkOpenResult> {
    const path = payload.path?.trim();
    if (!path) return "invalid";

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return "no-vault";

    const absPath = collapseTraversal(resolveVaultAbsolutePath(path, vaultPath));
    if (toVaultRelativePath(absPath, vaultPath) === null) {
        return "outside-vault";
    }

    // Capture the note (if any) before opening so we can queue a line reveal
    // once the tab is active. Match on the normalized path so notes resolve on
    // Windows too, where `note.path` uses backslashes.
    const note = useVaultStore
        .getState()
        .notes.find((entry) => normalizeVaultPath(entry.path) === absPath);

    const opened = await openAiEditedFileByAbsolutePath(absPath);
    if (!opened) return "not-found";

    if (note && payload.line) {
        useEditorStore.getState().queueLineReveal({
            noteId: note.id,
            line: payload.line,
            endLine: payload.endLine ?? null,
        });
    }

    return "opened";
}
