import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
import { resolveVaultAbsolutePath } from "../../app/utils/vaultPaths";
import { useVaultStore } from "../../app/store/vaultStore";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import { getPathBaseName } from "../../app/utils/path";

interface MapEntryDto {
    id: string;
    title: string;
    relative_path: string;
}

interface MapEntry {
    id: string;
    title: string;
    relativePath: string;
}

const DRAG_THRESHOLD = 5;

interface DragState {
    map: MapEntry;
    startX: number;
    startY: number;
    active: boolean;
}

export function MapsPanel() {
    const [maps, setMaps] = useState<MapEntry[]>([]);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const openMap = useEditorStore((s) => s.openMap);
    const activeMapRelativePath = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && isMapTab(tab) ? tab.relativePath : null;
    });

    const dragStateRef = useRef<DragState | null>(null);

    const resetDrag = useCallback(() => {
        if (dragStateRef.current?.active) {
            emitFileTreeNoteDrag({ phase: "cancel", x: 0, y: 0, notes: [] });
        }
        dragStateRef.current = null;
    }, []);

    const handleItemMouseDown = useCallback(
        (map: MapEntry, e: React.MouseEvent) => {
            if (e.button !== 0) return;
            dragStateRef.current = {
                map,
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            };
        },
        [],
    );

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            const s = dragStateRef.current;
            if (!s) return;

            const dx = e.clientX - s.startX;
            const dy = e.clientY - s.startY;
            const filePath = resolveVaultAbsolutePath(
                s.map.relativePath,
                vaultPath,
            );
            const fileName = getPathBaseName(s.map.relativePath) || s.map.title;

            if (!s.active) {
                if (
                    Math.abs(dx) < DRAG_THRESHOLD &&
                    Math.abs(dy) < DRAG_THRESHOLD
                )
                    return;
                s.active = true;
                emitFileTreeNoteDrag({
                    phase: "start",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [],
                    files: [
                        {
                            filePath,
                            fileName,
                            mimeType: "application/json",
                        },
                    ],
                });
                return;
            }

            emitFileTreeNoteDrag({
                phase: "move",
                x: e.clientX,
                y: e.clientY,
                notes: [],
                files: [
                    {
                        filePath,
                        fileName,
                        mimeType: "application/json",
                    },
                ],
            });
        };

        const handleMouseUp = (e: MouseEvent) => {
            const s = dragStateRef.current;
            if (!s) return;

            if (s.active) {
                emitFileTreeNoteDrag({
                    phase: "end",
                    x: e.clientX,
                    y: e.clientY,
                    notes: [],
                    files: [
                        {
                            filePath: resolveVaultAbsolutePath(
                                s.map.relativePath,
                                vaultPath,
                            ),
                            fileName:
                                getPathBaseName(s.map.relativePath) ||
                                s.map.title,
                            mimeType: "application/json",
                        },
                    ],
                });
            }

            dragStateRef.current = null;
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
            resetDrag();
        };
    }, [resetDrag, vaultPath]);

    useEffect(() => {
        if (!vaultPath) return;

        let cancelled = false;

        void invoke<MapEntryDto[]>("list_maps", { vaultPath }).then(
            (nextMaps) => {
                if (cancelled) return;
                setMaps(
                    nextMaps.map((entry) => ({
                        id: entry.id,
                        title: entry.title,
                        relativePath: entry.relative_path,
                    })),
                );
            },
        );

        return () => {
            cancelled = true;
        };
    }, [vaultPath]);

    const handleNewMap = async () => {
        if (!vaultPath) return;
        const name = `Map ${new Date().toLocaleDateString("en-CA")}`;
        const entry = await invoke<MapEntryDto>("create_map", {
            vaultPath,
            name,
        });
        const nextEntry = {
            id: entry.id,
            title: entry.title,
            relativePath: entry.relative_path,
        };
        setMaps((prev) => [nextEntry, ...prev]);
        openMap(nextEntry.relativePath, nextEntry.title);
    };

    const handleDeleteMap = async (map: MapEntry) => {
        if (!vaultPath) return;
        await invoke("delete_map", {
            vaultPath,
            relativePath: map.relativePath,
        });
        setMaps((prev) =>
            prev.filter((m) => m.relativePath !== map.relativePath),
        );
        // Close any open tab for this map
        const { tabs, closeTab } = useEditorStore.getState();
        const openTab = tabs.find(
            (t) => isMapTab(t) && t.relativePath === map.relativePath,
        );
        if (openTab) closeTab(openTab.id, { reason: "delete" });
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-(--border)">
                <span className="text-xs font-medium text-(--text-secondary) uppercase tracking-wide">
                    Concept Maps
                </span>
                <button
                    onClick={handleNewMap}
                    className="p-1 rounded hover:bg-(--bg-tertiary) text-(--text-secondary) hover:text-(--text-primary)"
                    title="New Concept Map"
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M8 3v10M3 8h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto py-1">
                {maps.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-(--text-secondary)">
                        No concept maps yet.
                        <br />
                        <button
                            onClick={handleNewMap}
                            className="mt-2 text-(--accent) hover:underline"
                        >
                            Create one
                        </button>
                    </div>
                ) : (
                    maps.map((map) => (
                        <div
                            key={map.relativePath}
                            className="group flex items-center hover:bg-(--bg-tertiary)"
                            style={
                                activeMapRelativePath === map.relativePath
                                    ? {
                                          backgroundColor:
                                              "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))",
                                      }
                                    : undefined
                            }
                        >
                            <button
                                onClick={() =>
                                    openMap(map.relativePath, map.title)
                                }
                                onMouseDown={(e) => handleItemMouseDown(map, e)}
                                className="flex-1 text-left px-3 py-1.5 text-sm text-(--text-primary) truncate"
                            >
                                {map.title}
                            </button>
                            <button
                                onClick={() => void handleDeleteMap(map)}
                                className="hidden group-hover:flex items-center justify-center shrink-0 mr-2 w-5 h-5 rounded text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-primary)"
                                title="Delete map"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                >
                                    <path d="M4 4l8 8M12 4l-8 8" />
                                </svg>
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
