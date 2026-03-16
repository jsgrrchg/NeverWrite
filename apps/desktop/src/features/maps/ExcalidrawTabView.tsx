import React, { useEffect, useState, useCallback, useRef } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
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
    forPath: string;
    elements: ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
}

interface QueuedSave {
    path: string;
    content: string;
    signature: string;
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

    pendingSavesRef.current.delete(nextSave.path);
    activeSaveRef.current = nextSave;

    invoke<void>("save_map", {
        path: nextSave.path,
        content: nextSave.content,
    })
        .then(() => {
            persistedSignaturesRef.current.set(
                nextSave.path,
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
    pendingSavesRef.current.set(scheduledSave.path, scheduledSave);
    flushSaveQueue(activeSaveRef, pendingSavesRef, persistedSignaturesRef);
}

export function ExcalidrawTabView() {
    const filePath = useEditorStore((s) => {
        const t = s.tabs.find((t) => t.id === s.activeTabId);
        return t && isMapTab(t) ? t.filePath : null;
    });
    const isDark = useThemeStore((s) => s.isDark);

    const [loaded, setLoaded] = useState<LoadedData | null>(null);

    const [excalidrawAPI, setExcalidrawAPI] =
        useState<ExcalidrawImperativeAPI | null>(null);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const filePathRef = useRef(filePath);
    const persistedSignaturesRef = useRef(new Map<string, string>());
    const scheduledSaveRef = useRef<QueuedSave | null>(null);
    const activeSaveRef = useRef<QueuedSave | null>(null);
    const pendingSavesRef = useRef(new Map<string, QueuedSave>());

    useEffect(() => {
        filePathRef.current = filePath;
    }, [filePath]);

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
        if (!filePath) return;

        let cancelled = false;

        Promise.all([
            invoke<string>("read_map", { path: filePath }),
            loadExcalidrawModule(),
        ])
            .then(([json, excalidraw]) => {
                if (cancelled) return;

                const data = JSON.parse(json);
                const elements = data.elements ?? [];
                const appState = data.appState ?? {};
                const files = data.files ?? {};

                persistedSignaturesRef.current.set(
                    filePath,
                    getSceneSignature(
                        excalidraw.getSceneVersion,
                        elements,
                        appState,
                    ),
                );

                setLoaded({
                    forPath: filePath,
                    elements,
                    appState,
                    files,
                });
            })
            .catch(() => {
                if (cancelled) return;

                persistedSignaturesRef.current.set(filePath, "0:");
                setLoaded({
                    forPath: filePath,
                    elements: [],
                    appState: {},
                    files: {},
                });
            });

        return () => {
            cancelled = true;
        };
    }, [filePath]);

    const handleChange = useCallback(
        (
            elements: readonly ExcalidrawElement[],
            appState: AppState,
            files: BinaryFiles,
        ) => {
            const path = filePathRef.current;
            const excalidraw = excalidrawModuleCache;
            if (!path || !excalidraw) return;

            const signature = getSceneSignature(
                excalidraw.getSceneVersion,
                elements,
                appState,
            );
            const persistedSignature = persistedSignaturesRef.current.get(path);
            const scheduledSignature =
                scheduledSaveRef.current?.path === path
                    ? scheduledSaveRef.current.signature
                    : null;
            const pendingSignature =
                pendingSavesRef.current.get(path)?.signature ?? null;
            const activeSignature =
                activeSaveRef.current?.path === path
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
                    path,
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
    }, [filePath, flushScheduledSave]);

    // Listen for external changes (e.g. AI agent edits)
    useEffect(() => {
        const unlisten = listen<string>("map-external-change", (event) => {
            const changedPath = event.payload;
            if (changedPath !== filePathRef.current || !excalidrawAPI) return;

            invoke<string>("read_map", { path: changedPath })
                .then((json) => {
                    const data = JSON.parse(json);
                    excalidrawAPI.updateScene({
                        elements: data.elements ?? [],
                        appState: data.appState ?? {},
                    });
                    if (excalidrawModuleCache) {
                        persistedSignaturesRef.current.set(
                            changedPath,
                            getSceneSignature(
                                excalidrawModuleCache.getSceneVersion,
                                data.elements ?? [],
                                data.appState ?? {},
                            ),
                        );
                    }
                })
                .catch(console.error);
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [excalidrawAPI]);

    const ready = filePath && loaded && loaded.forPath === filePath;

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
                    key={filePath}
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
