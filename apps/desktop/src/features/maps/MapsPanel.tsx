import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@neverwrite/runtime";
import { openPath, revealItemInDir } from "@neverwrite/runtime";
import { useEditorStore } from "../../app/store/editorStore";
import { resolveVaultAbsolutePath } from "../../app/utils/vaultPaths";
import { useVaultStore, type VaultEntryDto } from "../../app/store/vaultStore";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import { getPathBaseName } from "../../app/utils/path";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { logError } from "../../app/utils/runtimeLog";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { SidebarFilterInput } from "../../components/layout/SidebarFilterInput";

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

type MapsContextPayload = {
    kind: "map";
    map: MapEntry;
};

const DRAG_THRESHOLD = 5;

interface DragState {
    map: MapEntry;
    startX: number;
    startY: number;
    active: boolean;
}

function getMapTitleFromRelativePath(relativePath: string) {
    const fileName = getPathBaseName(relativePath) || relativePath;
    return fileName.replace(/\.excalidraw$/i, "") || fileName;
}

function buildRenamedMapRelativePath(
    currentRelativePath: string,
    nextTitle: string,
) {
    const normalizedTitle = nextTitle
        .trim()
        .replace(/\.excalidraw$/i, "")
        .trim();
    if (
        !normalizedTitle ||
        normalizedTitle === "." ||
        normalizedTitle === ".." ||
        normalizedTitle.includes("/") ||
        normalizedTitle.includes("\\")
    ) {
        return null;
    }

    const parentPath =
        currentRelativePath.lastIndexOf("/") >= 0
            ? currentRelativePath.slice(0, currentRelativePath.lastIndexOf("/"))
            : "";
    const fileName = `${normalizedTitle}.excalidraw`;
    return parentPath ? `${parentPath}/${fileName}` : fileName;
}

export function MapsPanel() {
    const [maps, setMaps] = useState<MapEntry[]>([]);
    const [contextMenu, setContextMenu] =
        useState<ContextMenuState<MapsContextPayload> | null>(null);
    const [renamingMapPath, setRenamingMapPath] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [filterText, setFilterText] = useState("");
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const openMap = useEditorStore((s) => s.openMap);
    const handleMapDeleted = useEditorStore((s) => s.handleMapDeleted);
    const handleMapRenamed = useEditorStore((s) => s.handleMapRenamed);
    const activeMapRelativePath = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab?.kind === "map" ? tab.relativePath : null;
    });

    const dragStateRef = useRef<DragState | null>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);

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

    useEffect(() => {
        if (!renamingMapPath) return;

        requestAnimationFrame(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        });
    }, [renamingMapPath]);

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

    const handleDeleteMap = useCallback(
        async (map: MapEntry) => {
            if (!vaultPath) return;
            setContextMenu(null);
            if (renamingMapPath === map.relativePath) {
                setRenamingMapPath(null);
                setRenameValue("");
            }
            await invoke("delete_map", {
                vaultPath,
                relativePath: map.relativePath,
            });
            setMaps((prev) =>
                prev.filter((entry) => entry.relativePath !== map.relativePath),
            );
            handleMapDeleted(map.relativePath);
        },
        [handleMapDeleted, renamingMapPath, vaultPath],
    );

    const handleMapContextMenu = useCallback(
        (event: React.MouseEvent, map: MapEntry) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
                x: event.clientX,
                y: event.clientY,
                payload: { kind: "map", map },
            });
        },
        [],
    );

    const handleRenameStart = useCallback((map: MapEntry) => {
        setContextMenu(null);
        setRenamingMapPath(map.relativePath);
        setRenameValue(map.title);
    }, []);

    const handleRenameCancel = useCallback(() => {
        setRenamingMapPath(null);
        setRenameValue("");
    }, []);

    const handleRenameConfirm = useCallback(
        async (map: MapEntry) => {
            const nextRelativePath = buildRenamedMapRelativePath(
                map.relativePath,
                renameValue,
            );
            if (!nextRelativePath) {
                handleRenameCancel();
                return;
            }
            if (nextRelativePath === map.relativePath) {
                handleRenameCancel();
                return;
            }

            try {
                const updated = await vaultInvoke<VaultEntryDto>(
                    "move_vault_entry",
                    {
                        relativePath: map.relativePath,
                        newRelativePath: nextRelativePath,
                    },
                );
                const nextTitle = getMapTitleFromRelativePath(
                    updated.relative_path,
                );

                setMaps((prev) =>
                    prev.map((entry) =>
                        entry.relativePath === map.relativePath
                            ? {
                                  id: updated.id,
                                  title: nextTitle,
                                  relativePath: updated.relative_path,
                              }
                            : entry,
                    ),
                );

                handleMapRenamed(
                    map.relativePath,
                    updated.relative_path,
                    nextTitle,
                );
            } catch (error) {
                logError("maps-panel", "Failed to rename map", error);
            } finally {
                handleRenameCancel();
            }
        },
        [handleMapRenamed, handleRenameCancel, renameValue],
    );

    const contextMenuEntries = useMemo<ContextMenuEntry[]>(() => {
        if (!contextMenu) return [];

        const { map } = contextMenu.payload;
        return [
            {
                label: "Open",
                action: () => openMap(map.relativePath, map.title),
            },
            { type: "separator" },
            {
                label: "Rename",
                action: () => handleRenameStart(map),
            },
            {
                label: "Open Externally",
                action: () =>
                    void openPath(
                        resolveVaultAbsolutePath(map.relativePath, vaultPath),
                    ),
                disabled: !vaultPath,
            },
            {
                label: "Reveal in Finder",
                action: () =>
                    void revealItemInDir(
                        resolveVaultAbsolutePath(map.relativePath, vaultPath),
                    ),
                disabled: !vaultPath,
            },
            {
                label: "Copy Path",
                action: () =>
                    void navigator.clipboard.writeText(map.relativePath),
            },
            { type: "separator" },
            {
                label: "Delete Map",
                action: () => void handleDeleteMap(map),
                danger: true,
            },
        ];
    }, [contextMenu, handleDeleteMap, handleRenameStart, openMap, vaultPath]);

    const filteredMaps = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        if (!q) return maps;
        return maps.filter((map) => map.title.toLowerCase().includes(q));
    }, [maps, filterText]);

    return (
        <div className="flex flex-col h-full">
            <div
                className="shrink-0"
                style={{ borderBottom: "1px solid var(--border)" }}
            >
                <div className="flex items-center justify-between px-3 py-2">
                    <span
                        className="text-xs font-semibold uppercase tracking-wider"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Concept Maps
                    </span>
                    <button
                        onClick={handleNewMap}
                        title="New Concept Map"
                        className="flex items-center justify-center rounded transition-opacity"
                        style={{
                            width: 18,
                            height: 18,
                            color: "var(--text-secondary)",
                            opacity: 0.5,
                        }}
                        onMouseEnter={(e) =>
                            (e.currentTarget.style.opacity = "1")
                        }
                        onMouseLeave={(e) =>
                            (e.currentTarget.style.opacity = "0.5")
                        }
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        >
                            <path d="M8 3v10M3 8h10" />
                        </svg>
                    </button>
                </div>
                <div className="px-2 pb-2">
                    <SidebarFilterInput
                        value={filterText}
                        onChange={setFilterText}
                        placeholder="Filter maps..."
                    />
                </div>
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
                ) : filteredMaps.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-(--text-secondary)">
                        No maps match &ldquo;{filterText}&rdquo;
                    </div>
                ) : (
                    filteredMaps.map((map) => (
                        <div
                            key={map.relativePath}
                            className="group flex items-center hover:bg-(--bg-tertiary)"
                            onContextMenu={(event) =>
                                handleMapContextMenu(event, map)
                            }
                            style={
                                activeMapRelativePath === map.relativePath
                                    ? {
                                          backgroundColor:
                                              "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))",
                                      }
                                    : undefined
                            }
                        >
                            {renamingMapPath === map.relativePath ? (
                                <div className="flex-1 px-2 py-1">
                                    <input
                                        ref={renameInputRef}
                                        value={renameValue}
                                        onChange={(event) =>
                                            setRenameValue(
                                                event.currentTarget.value,
                                            )
                                        }
                                        onBlur={handleRenameCancel}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                void handleRenameConfirm(map);
                                            } else if (event.key === "Escape") {
                                                event.preventDefault();
                                                handleRenameCancel();
                                            }
                                        }}
                                        className="w-full px-2 py-1 text-sm rounded border border-(--border) bg-(--bg-primary) text-(--text-primary) outline-none focus:border-(--accent)"
                                        aria-label={`Rename ${map.title}`}
                                    />
                                </div>
                            ) : (
                                <button
                                    onClick={() =>
                                        openMap(map.relativePath, map.title)
                                    }
                                    onMouseDown={(e) =>
                                        handleItemMouseDown(map, e)
                                    }
                                    className="flex-1 min-w-0 text-left px-3 py-1.5 text-sm text-(--text-primary) truncate"
                                >
                                    {map.title}
                                </button>
                            )}
                            <button
                                onClick={() => void handleDeleteMap(map)}
                                disabled={renamingMapPath === map.relativePath}
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

            {contextMenu ? (
                <ContextMenu
                    menu={contextMenu}
                    entries={contextMenuEntries}
                    onClose={() => setContextMenu(null)}
                />
            ) : null}
        </div>
    );
}
