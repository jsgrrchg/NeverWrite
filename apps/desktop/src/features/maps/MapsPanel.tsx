import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore, isMapTab } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import { getPathBaseName } from "../../app/utils/path";

interface MapEntry {
    id: string;
    title: string;
    path: string;
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
    const activeMapPath = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && isMapTab(tab) ? tab.filePath : null;
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
                            filePath: s.map.path,
                            fileName:
                                getPathBaseName(s.map.path) || s.map.title,
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
                        filePath: s.map.path,
                        fileName: getPathBaseName(s.map.path) || s.map.title,
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
                            filePath: s.map.path,
                            fileName:
                                getPathBaseName(s.map.path) || s.map.title,
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
        };
    }, []);

    const loadMaps = useCallback(() => {
        if (!vaultPath) return;
        invoke<MapEntry[]>("list_maps", { vaultPath }).then(setMaps);
    }, [vaultPath]);

    useEffect(() => {
        loadMaps();
    }, [loadMaps]);

    const handleNewMap = async () => {
        if (!vaultPath) return;
        const name = `Map ${new Date().toLocaleDateString("en-CA")}`;
        const entry = await invoke<MapEntry>("create_map", { vaultPath, name });
        setMaps((prev) => [entry, ...prev]);
        openMap(entry.path, entry.id, entry.title);
    };

    const handleDeleteMap = async (map: MapEntry) => {
        await invoke("delete_map", { path: map.path });
        setMaps((prev) => prev.filter((m) => m.path !== map.path));
        // Close any open tab for this map
        const { tabs, closeTab } = useEditorStore.getState();
        const openTab = tabs.find(
            (t) => isMapTab(t) && t.filePath === map.path,
        );
        if (openTab) closeTab(openTab.id);
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
                            key={map.path}
                            className="group flex items-center hover:bg-(--bg-tertiary)"
                            style={
                                activeMapPath === map.path
                                    ? {
                                          backgroundColor:
                                              "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))",
                                      }
                                    : undefined
                            }
                        >
                            <button
                                onClick={() =>
                                    openMap(map.path, map.id, map.title)
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
