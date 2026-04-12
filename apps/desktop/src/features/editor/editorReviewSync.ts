import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "../ai/store/chatStore";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
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

function getTrackedReloadComparisonContent(
    target: EditorTarget,
    currentEditorContent?: string | null,
) {
    if (typeof currentEditorContent === "string") {
        return currentEditorContent;
    }

    return target.openTab?.content ?? null;
}

function shouldSkipTrackedReload(
    target: EditorTarget,
    nextContent: string,
    currentEditorContent?: string | null,
) {
    return (
        getTrackedReloadComparisonContent(target, currentEditorContent) ===
        nextContent
    );
}

function normalizeTrackedEditorText(text: string) {
    return text.replace(/\r/g, "");
}

function shouldForceTrackedReload(
    target: EditorTarget,
    tracked: TrackedFile,
    currentEditorContent?: string | null,
) {
    const openContent = getTrackedReloadComparisonContent(
        target,
        currentEditorContent,
    );
    if (openContent == null) {
        return false;
    }

    const normalizedOpenContent = normalizeTrackedEditorText(openContent);
    const normalizedTrackedCurrentText = normalizeTrackedEditorText(
        tracked.currentText,
    );

    if (normalizedOpenContent === normalizedTrackedCurrentText) {
        return false;
    }

    // Allow a recovery reload when the editor was transiently cleared but the
    // tracked snapshot still contains real content.
    if (
        normalizedOpenContent.length === 0 &&
        normalizedTrackedCurrentText.length > 0
    ) {
        return true;
    }

    // The safe automatic reload path is when the open tab still matches the
    // tracked pre-agent baseline. If the user/editor already has a different
    // full-document view, do not overwrite it with a possibly degraded tracked
    // snapshot.
    return (
        normalizedOpenContent === normalizeTrackedEditorText(tracked.diffBase)
    );
}

export function syncTrackedEditorReviewTarget(
    target: EditorTarget | null,
    sessionsById: Record<string, AIChatSession>,
    options?: {
        currentEditorContent?: string | null;
    },
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

    if (
        shouldSkipTrackedReload(
            target,
            tracked.currentText,
            options?.currentEditorContent,
        )
    ) {
        return false;
    }

    if (
        !shouldForceTrackedReload(
            target,
            tracked,
            options?.currentEditorContent,
        )
    ) {
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
    getCurrentEditorContent?: () => string | null,
) {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (sessionsById = useChatStore.getState().sessionsById) => {
        timer = null;
        syncTrackedEditorReviewTarget(getTarget(), sessionsById, {
            currentEditorContent: getCurrentEditorContent?.() ?? null,
        });
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
