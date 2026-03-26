import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "../ai/store/chatStore";
import type { AIChatSession } from "../ai/types";
import type { EditorTarget } from "./editorTargetResolver";
import { shouldSyncTrackedEditorReviewTarget } from "./editorReviewGate";
import { resolveTrackedFileMatchForPaths } from "./trackedFileMatch";

function getTargetCandidatePaths(target: EditorTarget): string[] {
    if (target.kind === "note") {
        const candidates = [target.absolutePath];
        if (!target.noteId.startsWith("/")) {
            candidates.push(`${target.noteId}.md`);
        } else {
            candidates.push(target.noteId);
        }
        return candidates;
    }

    return [target.absolutePath, target.relativePath];
}

function shouldSkipTrackedReload(target: EditorTarget, nextContent: string) {
    return target.openTab?.content === nextContent;
}

export function syncTrackedEditorReviewTarget(
    target: EditorTarget | null,
    sessionsById: Record<string, AIChatSession>,
): boolean {
    if (!shouldSyncTrackedEditorReviewTarget()) {
        return false;
    }

    if (!target?.openTab) {
        return false;
    }

    const { match } = resolveTrackedFileMatchForPaths(
        getTargetCandidatePaths(target),
        sessionsById,
        {
            vaultPath: useVaultStore.getState().vaultPath,
        },
    );
    if (!match?.trackedFile.isText) {
        return false;
    }

    const tracked = match.trackedFile;
    if (
        tracked.status.kind === "created" &&
        tracked.status.existingFileContent === null &&
        target.openTab.content !== tracked.currentText
    ) {
        return false;
    }

    if (shouldSkipTrackedReload(target, tracked.currentText)) {
        return false;
    }

    useEditorStore.getState().forceReloadEditorTarget(target, {
        content: tracked.currentText,
        title: target.openTab.title ?? target.absolutePath,
        origin: "agent",
    });
    return true;
}

export function subscribeEditorReviewSync(
    getTarget: () => EditorTarget | null,
) {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (sessionsById = useChatStore.getState().sessionsById) => {
        timer = null;
        syncTrackedEditorReviewTarget(getTarget(), sessionsById);
    };

    const schedule = (sessionsById = useChatStore.getState().sessionsById) => {
        if (timer) {
            clearTimeout(timer);
        }

        // Defer tracked reloads to the next macrotask so CodeMirror does not
        // receive a force-reload transaction while React/Zustand are still
        // propagating the upstream review state update.
        timer = setTimeout(() => flush(sessionsById), 0);
    };

    flush();

    const unsubscribe = useChatStore.subscribe((state, prev) => {
        if (state.sessionsById === prev.sessionsById) {
            return;
        }

        schedule(state.sessionsById);
    });

    return () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        unsubscribe();
    };
}
