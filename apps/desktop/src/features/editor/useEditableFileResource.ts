import { useCallback, useEffect, useRef } from "react";
import {
    fileViewerNeedsTextContent,
    isFileTab,
    useEditorStore,
    type FileTab,
    type Tab,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    buildLiveFilePathCacheKey,
    clearFilePathStateCaches,
    pruneFilePathStateCaches,
    type FilePathStateCacheCollection,
} from "./filePathStateCache";
import { logError } from "../../app/utils/runtimeLog";

type SavedVaultFileDetail = {
    relative_path: string;
    file_name: string;
    content: string;
    size_bytes?: number | null;
    content_truncated?: boolean;
};

type FileReloadMetadata = {
    origin?: "user" | "agent" | "external" | "system" | "unknown";
    opId?: string | null;
    revision?: number;
    contentHash?: string | null;
};

type EditableFileTab = NonNullable<ReturnType<typeof getActiveEditableFileTab>>;

interface UseEditableFileResourceOptions {
    getCurrentContent: () => string | null;
    applyIncomingContent: (nextContent: string) => void;
    acceptTab?: (tab: FileTab) => boolean;
    autosaveDelayMs?: number;
}

// Shared file-editing orchestration so multiple viewers can reuse the same
// autosave, reload and external-conflict behavior without diverging.
export function useEditableFileResource({
    getCurrentContent,
    applyIncomingContent,
    acceptTab = defaultAcceptEditableFileTab,
    autosaveDelayMs = 300,
}: UseEditableFileResourceOptions) {
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousTabRef = useRef<EditableFileTab | null>(null);
    const tabRef = useRef<EditableFileTab | null>(null);
    const lastSavedContentByPathRef = useRef(new Map<string, string>());
    const lastAckRevisionByPathRef = useRef(new Map<string, number>());
    const pendingLocalOpIdByPathRef = useRef(new Map<string, string>());
    const saveRequestIdByPathRef = useRef(new Map<string, number>());
    const lastLiveFilePathCacheKeyRef = useRef<string | null>(null);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const lastVaultPathRef = useRef<string | null>(vaultPath);

    const tab = useEditorStore((state) =>
        getActiveEditableFileTab(state, acceptTab),
    );
    const hasExternalConflict = useEditorStore((state) => {
        const relativePath = tab?.relativePath;
        return relativePath
            ? state.fileExternalConflicts.has(relativePath)
            : false;
    });

    useEffect(() => {
        tabRef.current = tab;
    }, [tab]);

    const getFilePathStateCaches = useCallback(
        (): FilePathStateCacheCollection => ({
            lastSavedContentByPath: lastSavedContentByPathRef.current,
            lastAckRevisionByPath: lastAckRevisionByPathRef.current,
            pendingLocalOpIdByPath: pendingLocalOpIdByPathRef.current,
            saveRequestIdByPath: saveRequestIdByPathRef.current,
        }),
        [],
    );

    const pruneFilePathStateForOpenTabs = useCallback(
        (tabs: readonly Tab[]) => {
            pruneFilePathStateCaches(tabs, getFilePathStateCaches());
        },
        [getFilePathStateCaches],
    );

    useEffect(() => {
        if (lastVaultPathRef.current === vaultPath) return;
        lastVaultPathRef.current = vaultPath;
        lastLiveFilePathCacheKeyRef.current = null;
        clearFilePathStateCaches(getFilePathStateCaches());
    }, [getFilePathStateCaches, vaultPath]);

    useEffect(() => {
        const syncLiveFilePathState = (tabs: readonly Tab[]) => {
            const nextKey = buildLiveFilePathCacheKey(tabs);
            if (lastLiveFilePathCacheKeyRef.current === nextKey) return;
            lastLiveFilePathCacheKeyRef.current = nextKey;
            pruneFilePathStateForOpenTabs(tabs);
        };

        syncLiveFilePathState(useEditorStore.getState().tabs);
        const unsubscribe = useEditorStore.subscribe((state) => {
            syncLiveFilePathState(state.tabs);
        });
        return unsubscribe;
    }, [pruneFilePathStateForOpenTabs]);

    const saveFile = useCallback(
        async (targetTab: EditableFileTab, content: string) => {
            const lastSaved = lastSavedContentByPathRef.current.get(
                targetTab.relativePath,
            );
            if (lastSaved === content) {
                return;
            }

            const requestId =
                (saveRequestIdByPathRef.current.get(targetTab.relativePath) ??
                    0) + 1;
            saveRequestIdByPathRef.current.set(
                targetTab.relativePath,
                requestId,
            );
            const localOpId =
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `local-file-save-${Date.now()}-${Math.random()}`;

            // Track the save op so incoming reload events can distinguish a local
            // save acknowledgement from a genuine external overwrite.
            pendingLocalOpIdByPathRef.current.set(
                targetTab.relativePath,
                localOpId,
            );

            try {
                const detail = await vaultInvoke<SavedVaultFileDetail>(
                    "save_vault_file",
                    {
                        relativePath: targetTab.relativePath,
                        content,
                        opId: localOpId,
                    },
                );
                if (
                    saveRequestIdByPathRef.current.get(
                        targetTab.relativePath,
                    ) !== requestId
                ) {
                    return;
                }

                lastSavedContentByPathRef.current.set(
                    targetTab.relativePath,
                    detail.content,
                );

                const store = useEditorStore.getState();
                store.setTabDirty(targetTab.id, false);
                store.updateFileHistoryTitle(
                    targetTab.id,
                    targetTab.relativePath,
                    detail.file_name,
                );
                store.reloadFileContent(targetTab.relativePath, {
                    title: detail.file_name,
                    content: detail.content,
                    sizeBytes: detail.size_bytes ?? null,
                    contentTruncated: Boolean(detail.content_truncated),
                    origin: "user",
                    opId: localOpId,
                });
                store.clearFileExternalConflict(targetTab.relativePath);
            } catch (error) {
                pendingLocalOpIdByPathRef.current.delete(
                    targetTab.relativePath,
                );
                logError("file-editor", "Failed to save vault file", error);
            }
        },
        [],
    );

    const scheduleSave = useCallback(
        (targetTab: EditableFileTab, content: string) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }

            saveTimerRef.current = setTimeout(() => {
                saveTimerRef.current = null;
                void saveFile(targetTab, content);
            }, autosaveDelayMs);
        },
        [autosaveDelayMs, saveFile],
    );

    const handleLocalContentChange = useCallback(
        (content: string) => {
            const currentTab = tabRef.current;
            if (!currentTab) {
                return;
            }

            const lastSaved =
                lastSavedContentByPathRef.current.get(
                    currentTab.relativePath,
                ) ?? currentTab.content;
            const store = useEditorStore.getState();
            store.updateTabContent(currentTab.id, content);
            store.setTabDirty(currentTab.id, content !== lastSaved);
            scheduleSave(currentTab, content);
        },
        [scheduleSave],
    );

    const flushPendingSave = useCallback(
        async (targetTab: EditableFileTab | null, content: string | null) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (!targetTab || content === null) {
                return;
            }

            const lastSaved =
                lastSavedContentByPathRef.current.get(targetTab.relativePath) ??
                targetTab.content;
            if (content === lastSaved) {
                return;
            }

            await saveFile(targetTab, content);
        },
        [saveFile],
    );

    useEffect(() => {
        const previousTab = previousTabRef.current;
        const currentTab = tabRef.current;
        const currentContent = getCurrentContent();

        if (previousTab) {
            void flushPendingSave(previousTab, currentContent);
        }

        previousTabRef.current = currentTab;

        if (!currentTab) {
            return;
        }

        applyIncomingContent(currentTab.content);
        lastSavedContentByPathRef.current.set(
            currentTab.relativePath,
            currentTab.content,
        );
        const store = useEditorStore.getState();
        store.setTabDirty(currentTab.id, false);
    }, [
        applyIncomingContent,
        flushPendingSave,
        getCurrentContent,
        tab?.id,
        tab?.relativePath,
    ]);

    useEffect(() => {
        const currentTab = tabRef.current;
        if (!currentTab) {
            return;
        }

        if (!lastSavedContentByPathRef.current.has(currentTab.relativePath)) {
            lastSavedContentByPathRef.current.set(
                currentTab.relativePath,
                currentTab.content,
            );
            useEditorStore.getState().setTabDirty(currentTab.id, false);
        }
    }, [tab?.content, tab?.relativePath]);

    useEffect(() => {
        const unsubscribe = useEditorStore.subscribe((state, prev) => {
            const activeTabId = state.activeTabId;
            if (!activeTabId) return;

            const currentTab = state.tabs.find(
                (candidate) => candidate.id === activeTabId,
            );
            const previousTab = prev.tabs.find(
                (candidate) => candidate.id === activeTabId,
            );
            if (!currentTab || !previousTab) return;
            if (!isFileTab(currentTab) || !isFileTab(previousTab)) return;
            if (!acceptTab(currentTab) || !acceptTab(previousTab)) {
                return;
            }
            if (currentTab.relativePath !== previousTab.relativePath) {
                return;
            }

            const relativePath = currentTab.relativePath;
            const reloadVersion =
                state._fileReloadVersions?.[relativePath] ?? 0;
            const previousReloadVersion =
                prev._fileReloadVersions?.[relativePath] ?? 0;
            const isForced =
                state._pendingForceFileReloads?.has(relativePath) ?? false;

            if (reloadVersion === previousReloadVersion && !isForced) {
                return;
            }

            const currentContent = getCurrentContent();
            if (currentContent === null) {
                return;
            }

            const lastSaved =
                lastSavedContentByPathRef.current.get(relativePath) ?? null;
            const hasLocalUnsavedChanges =
                lastSaved !== null && currentContent !== lastSaved;
            const incomingContent = currentTab.content;
            const reloadMeta = (state._fileReloadMetadata?.[relativePath] ??
                null) as FileReloadMetadata | null;
            const incomingOrigin = reloadMeta?.origin ?? "unknown";
            const incomingOpId = reloadMeta?.opId ?? null;
            const incomingRevision = reloadMeta?.revision ?? 0;
            const lastAckRevision =
                lastAckRevisionByPathRef.current.get(relativePath) ?? 0;
            const pendingLocalOpId =
                pendingLocalOpIdByPathRef.current.get(relativePath) ?? null;
            const isPendingLocalSaveAck =
                !isForced &&
                incomingOrigin === "user" &&
                incomingOpId !== null &&
                incomingOpId === pendingLocalOpId;
            const isStaleRevision =
                !isForced &&
                incomingRevision > 0 &&
                incomingRevision <= lastAckRevision &&
                !isPendingLocalSaveAck;
            const acknowledgeIncomingRevision = () => {
                if (incomingRevision <= 0) return;
                lastAckRevisionByPathRef.current.set(
                    relativePath,
                    Math.max(lastAckRevision, incomingRevision),
                );
            };
            const clearPendingLocalAck = () => {
                if (isPendingLocalSaveAck) {
                    pendingLocalOpIdByPathRef.current.delete(relativePath);
                }
            };

            if (isStaleRevision) {
                clearPendingLocalAck();
                return;
            }

            if (!isForced && incomingContent === currentContent) {
                acknowledgeIncomingRevision();
                clearPendingLocalAck();
                if (lastSaved !== incomingContent) {
                    lastSavedContentByPathRef.current.set(
                        relativePath,
                        incomingContent,
                    );
                }
                const store = useEditorStore.getState();
                store.setTabDirty(currentTab.id, false);
                store.clearFileExternalConflict(relativePath);
                return;
            }

            if (hasLocalUnsavedChanges && !isForced) {
                if (isPendingLocalSaveAck) {
                    acknowledgeIncomingRevision();
                    clearPendingLocalAck();
                    lastSavedContentByPathRef.current.set(
                        relativePath,
                        incomingContent,
                    );
                    const store = useEditorStore.getState();
                    store.setTabDirty(currentTab.id, false);
                    store.clearFileExternalConflict(relativePath);
                    return;
                }
                useEditorStore
                    .getState()
                    .markFileExternalConflict(relativePath);
                return;
            }

            if (isForced) {
                useEditorStore.getState().clearForceFileReload(relativePath);
            }
            acknowledgeIncomingRevision();
            clearPendingLocalAck();
            const store = useEditorStore.getState();
            store.setTabDirty(currentTab.id, false);
            store.clearFileExternalConflict(relativePath);
            lastSavedContentByPathRef.current.set(
                relativePath,
                incomingContent,
            );
            applyIncomingContent(incomingContent);
        });

        return unsubscribe;
    }, [acceptTab, applyIncomingContent, getCurrentContent]);

    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, []);

    const reloadFileFromDisk = useCallback(async () => {
        const currentTab = tabRef.current;
        if (!currentTab) return;

        try {
            const detail = await vaultInvoke<SavedVaultFileDetail>(
                "read_vault_file",
                {
                    relativePath: currentTab.relativePath,
                },
            );
            useEditorStore
                .getState()
                .forceReloadFileContent(currentTab.relativePath, {
                    title: detail.file_name,
                    content: detail.content,
                    sizeBytes: detail.size_bytes ?? null,
                    contentTruncated: Boolean(detail.content_truncated),
                });
            useEditorStore
                .getState()
                .clearFileExternalConflict(currentTab.relativePath);
        } catch (error) {
            logError("file-editor", "Failed to reload vault file", error);
        }
    }, []);

    const keepLocalFileVersion = useCallback(() => {
        const currentTab = tabRef.current;
        if (!currentTab) return;
        useEditorStore
            .getState()
            .clearFileExternalConflict(currentTab.relativePath);
    }, []);

    const flushCurrentSave = useCallback(() => {
        void flushPendingSave(tabRef.current, getCurrentContent());
    }, [flushPendingSave, getCurrentContent]);

    return {
        tab,
        tabRef,
        hasExternalConflict,
        handleLocalContentChange,
        reloadFileFromDisk,
        keepLocalFileVersion,
        flushCurrentSave,
    };
}

function defaultAcceptEditableFileTab(tab: FileTab) {
    return fileViewerNeedsTextContent(tab.viewer);
}

function getActiveEditableFileTab(
    state: ReturnType<typeof useEditorStore.getState>,
    acceptTab: (tab: FileTab) => boolean,
) {
    const current = state.tabs.find(
        (candidate) => candidate.id === state.activeTabId,
    );

    return current && isFileTab(current) && acceptTab(current) ? current : null;
}
