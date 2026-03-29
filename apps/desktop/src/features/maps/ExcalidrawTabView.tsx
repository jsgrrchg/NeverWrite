import React, { useEffect, useState, useCallback, useRef } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useThemeStore } from "../../app/store/themeStore";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

let excalidrawModulePromise: Promise<ExcalidrawModule> | null = null;
let excalidrawModuleCache: ExcalidrawModule | null = null;

function loadExcalidrawModule() {
    if (!excalidrawModulePromise) {
        excalidrawModulePromise = import("@excalidraw/excalidraw").then(
            (mod) => {
                excalidrawModuleCache = mod;
                return mod;
            },
        );
    }

    return excalidrawModulePromise;
}

const Excalidraw = React.lazy(() =>
    loadExcalidrawModule().then((mod) => ({
        default: mod.Excalidraw,
    })),
);

interface LoadedData {
    forVaultPath: string;
    forRelativePath: string;
    elements: ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
}

interface QueuedSave {
    vaultPath: string;
    relativePath: string;
    content: string;
    signature: string;
}

interface MapChangedPayload {
    vault_path: string;
    relative_path: string;
}

function getQueuedSaveKey(vaultPath: string, relativePath: string) {
    return `${vaultPath}:${relativePath}`;
}

function getSceneSignature(
    getSceneVersion: ExcalidrawModule["getSceneVersion"],
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
) {
    const backgroundColor = appState.viewBackgroundColor ?? "";
    return `${getSceneVersion(elements)}:${backgroundColor}`;
}

function flushSaveQueue(
    activeSaveRef: MutableRefObject<QueuedSave | null>,
    pendingSavesRef: MutableRefObject<Map<string, QueuedSave>>,
    persistedSignaturesRef: MutableRefObject<Map<string, string>>,
) {
    if (activeSaveRef.current) return;

    const nextSave = pendingSavesRef.current.values().next().value;
    if (!nextSave) return;

    pendingSavesRef.current.delete(
        getQueuedSaveKey(nextSave.vaultPath, nextSave.relativePath),
    );
    activeSaveRef.current = nextSave;

    invoke<void>("save_map", {
        vaultPath: nextSave.vaultPath,
        relativePath: nextSave.relativePath,
        content: nextSave.content,
    })
        .then(() => {
            persistedSignaturesRef.current.set(
                getQueuedSaveKey(nextSave.vaultPath, nextSave.relativePath),
                nextSave.signature,
            );
        })
        .catch(console.error)
        .finally(() => {
            activeSaveRef.current = null;
            flushSaveQueue(
                activeSaveRef,
                pendingSavesRef,
                persistedSignaturesRef,
            );
        });
}

function flushScheduledSaveRefs(
    saveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
    scheduledSaveRef: MutableRefObject<QueuedSave | null>,
    activeSaveRef: MutableRefObject<QueuedSave | null>,
    pendingSavesRef: MutableRefObject<Map<string, QueuedSave>>,
    persistedSignaturesRef: MutableRefObject<Map<string, string>>,
) {
    if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
    }

    const scheduledSave = scheduledSaveRef.current;
    if (!scheduledSave) return;

    scheduledSaveRef.current = null;
    pendingSavesRef.current.set(
        getQueuedSaveKey(scheduledSave.vaultPath, scheduledSave.relativePath),
        scheduledSave,
    );
    flushSaveQueue(activeSaveRef, pendingSavesRef, persistedSignaturesRef);
}

export function ExcalidrawTabView() {
    const relativePath = useEditorStore((s) => {
        const t = s.tabs.find((t) => t.id === s.activeTabId);
        return t && isMapTab(t) ? t.relativePath : null;
    });
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const isDark = useThemeStore((s) => s.isDark);

    const [loaded, setLoaded] = useState<LoadedData | null>(null);

    const [excalidrawAPI, setExcalidrawAPI] =
        useState<ExcalidrawImperativeAPI | null>(null);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const relativePathRef = useRef(relativePath);
    const vaultPathRef = useRef(vaultPath);
    const persistedSignaturesRef = useRef(new Map<string, string>());
    const scheduledSaveRef = useRef<QueuedSave | null>(null);
    const activeSaveRef = useRef<QueuedSave | null>(null);
    const pendingSavesRef = useRef(new Map<string, QueuedSave>());

    useEffect(() => {
        relativePathRef.current = relativePath;
    }, [relativePath]);

    useEffect(() => {
        vaultPathRef.current = vaultPath;
    }, [vaultPath]);

    const flushScheduledSave = useCallback(() => {
        flushScheduledSaveRefs(
            saveTimerRef,
            scheduledSaveRef,
            activeSaveRef,
            pendingSavesRef,
            persistedSignaturesRef,
        );
    }, []);

    useEffect(() => {
        if (!vaultPath || !relativePath) return;

        let cancelled = false;
        const queuedSaveKey = getQueuedSaveKey(vaultPath, relativePath);

        Promise.all([
            invoke<string>("read_map", { vaultPath, relativePath }),
            loadExcalidrawModule(),
        ])
            .then(([json, excalidraw]) => {
                if (cancelled) return;

                const data = JSON.parse(json);
                const elements = data.elements ?? [];
                const appState = data.appState ?? {};
                const files = data.files ?? {};

                persistedSignaturesRef.current.set(
                    queuedSaveKey,
                    getSceneSignature(
                        excalidraw.getSceneVersion,
                        elements,
                        appState,
                    ),
                );

                setLoaded({
                    forVaultPath: vaultPath,
                    forRelativePath: relativePath,
                    elements,
                    appState,
                    files,
                });
            })
            .catch(() => {
                if (cancelled) return;

                persistedSignaturesRef.current.set(queuedSaveKey, "0:");
                setLoaded({
                    forVaultPath: vaultPath,
                    forRelativePath: relativePath,
                    elements: [],
                    appState: {},
                    files: {},
                });
            });

        return () => {
            cancelled = true;
        };
    }, [relativePath, vaultPath]);

    const handleChange = useCallback(
        (
            elements: readonly ExcalidrawElement[],
            appState: AppState,
            files: BinaryFiles,
        ) => {
            const currentVaultPath = vaultPathRef.current;
            const currentRelativePath = relativePathRef.current;
            const excalidraw = excalidrawModuleCache;
            if (!currentVaultPath || !currentRelativePath || !excalidraw) {
                return;
            }

            const saveKey = getQueuedSaveKey(
                currentVaultPath,
                currentRelativePath,
            );

            const signature = getSceneSignature(
                excalidraw.getSceneVersion,
                elements,
                appState,
            );
            const persistedSignature =
                persistedSignaturesRef.current.get(saveKey);
            const scheduledSignature =
                scheduledSaveRef.current?.vaultPath === currentVaultPath &&
                scheduledSaveRef.current?.relativePath === currentRelativePath
                    ? scheduledSaveRef.current.signature
                    : null;
            const pendingSignature =
                pendingSavesRef.current.get(saveKey)?.signature ?? null;
            const activeSignature =
                activeSaveRef.current?.vaultPath === currentVaultPath &&
                activeSaveRef.current?.relativePath === currentRelativePath
                    ? activeSaveRef.current.signature
                    : null;

            if (
                signature === persistedSignature ||
                signature === scheduledSignature ||
                signature === pendingSignature ||
                signature === activeSignature
            ) {
                return;
            }

            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }

            saveTimerRef.current = setTimeout(() => {
                saveTimerRef.current = null;
                scheduledSaveRef.current = {
                    vaultPath: currentVaultPath,
                    relativePath: currentRelativePath,
                    signature,
                    content: excalidraw.serializeAsJSON(
                        elements,
                        appState,
                        files,
                        "local",
                    ),
                };
                flushScheduledSaveRefs(
                    saveTimerRef,
                    scheduledSaveRef,
                    activeSaveRef,
                    pendingSavesRef,
                    persistedSignaturesRef,
                );
            }, 1200);
        },
        [],
    );

    useEffect(() => {
        return () => {
            flushScheduledSave();
        };
    }, [relativePath, flushScheduledSave]);

    // Listen for external changes (e.g. AI agent edits)
    useEffect(() => {
        const unlisten = listen<MapChangedPayload>(
            "map-external-change",
            (event) => {
                const payload = event.payload;
                if (
                    payload.vault_path !== vaultPathRef.current ||
                    payload.relative_path !== relativePathRef.current ||
                    !excalidrawAPI
                ) {
                    return;
                }

                const currentVaultPath = vaultPathRef.current;
                if (!currentVaultPath) {
                    return;
                }

                invoke<string>("read_map", {
                    vaultPath: currentVaultPath,
                    relativePath: payload.relative_path,
                })
                    .then((json) => {
                        const data = JSON.parse(json);
                        excalidrawAPI.updateScene({
                            elements: data.elements ?? [],
                            appState: data.appState ?? {},
                        });
                        if (excalidrawModuleCache) {
                            persistedSignaturesRef.current.set(
                                getQueuedSaveKey(
                                    currentVaultPath,
                                    payload.relative_path,
                                ),
                                getSceneSignature(
                                    excalidrawModuleCache.getSceneVersion,
                                    data.elements ?? [],
                                    data.appState ?? {},
                                ),
                            );
                        }
                    })
                    .catch(console.error);
            },
        );

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [excalidrawAPI]);

    const ready =
        vaultPath &&
        relativePath &&
        loaded &&
        loaded.forVaultPath === vaultPath &&
        loaded.forRelativePath === relativePath;

    if (!ready) {
        return (
            <div className="flex items-center justify-center h-full text-(--text-secondary)">
                Loading map…
            </div>
        );
    }

    return (
        <React.Suspense
            fallback={
                <div className="flex items-center justify-center h-full text-(--text-secondary)">
                    Loading editor…
                </div>
            }
        >
            <div className="w-full h-full">
                <Excalidraw
                    key={relativePath}
                    excalidrawAPI={setExcalidrawAPI}
                    initialData={loaded}
                    onChange={handleChange}
                    theme={isDark ? "dark" : "light"}
                    UIOptions={{
                        canvasActions: {
                            export: false,
                            loadScene: false,
                            saveToActiveFile: false,
                            toggleTheme: false,
                        },
                    }}
                />
            </div>
        </React.Suspense>
    );
}
