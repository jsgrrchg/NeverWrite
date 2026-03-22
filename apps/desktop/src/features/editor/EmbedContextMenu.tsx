import { useCallback, useMemo } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    ContextMenu,
    type ContextMenuEntry,
} from "../../components/context-menu/ContextMenu";
import { useVaultStore } from "../../app/store/vaultStore";
import { useEditorStore } from "../../app/store/editorStore";

export interface EmbedContextMenuState {
    x: number;
    y: number;
    payload: void;
    /** Wikilink target, e.g. "/assets/doc.pdf" or "/images/photo.png" */
    target: string;
    kind: "pdf" | "image";
}

export function EmbedContextMenu({
    menu,
    onClose,
}: {
    menu: EmbedContextMenuState;
    onClose: () => void;
}) {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const entries = useVaultStore((s) => s.entries);
    const { openPdf, openFile, insertExternalTab } = useEditorStore();

    const absolutePath = useMemo(() => {
        if (!vaultPath) return null;
        const rel = menu.target.startsWith("/")
            ? menu.target.slice(1)
            : menu.target;
        const sep =
            vaultPath.endsWith("/") || vaultPath.endsWith("\\") ? "" : "/";
        return `${vaultPath}${sep}${rel}`;
    }, [vaultPath, menu.target]);

    const vaultEntry = useMemo(() => {
        const rel = menu.target.startsWith("/")
            ? menu.target.slice(1)
            : menu.target;
        return entries.find((e) => e.relative_path === rel) ?? null;
    }, [entries, menu.target]);

    const fileName = menu.target.split("/").pop() ?? menu.target;

    const handleOpen = useCallback(() => {
        if (vaultEntry) {
            if (menu.kind === "pdf") {
                openPdf(vaultEntry.id, vaultEntry.title, vaultEntry.path);
            } else {
                openFile(
                    vaultEntry.relative_path,
                    vaultEntry.title,
                    vaultEntry.path,
                    "",
                    vaultEntry.mime_type,
                    "image",
                );
            }
        } else if (absolutePath) {
            void openPath(absolutePath);
        }
    }, [vaultEntry, absolutePath, menu.kind, openPdf, openFile]);

    const handleOpenNewTab = useCallback(() => {
        if (menu.kind === "pdf") {
            insertExternalTab({
                id: crypto.randomUUID(),
                kind: "pdf",
                entryId: vaultEntry?.id ?? menu.target,
                title: vaultEntry?.title ?? fileName,
                path: absolutePath ?? "",
                page: 1,
                zoom: 1,
                viewMode: "continuous",
            });
        } else if (vaultEntry) {
            insertExternalTab({
                id: crypto.randomUUID(),
                kind: "file",
                relativePath: vaultEntry.relative_path,
                title: vaultEntry.title,
                path: vaultEntry.path,
                content: "",
                mimeType: vaultEntry.mime_type,
                viewer: "image",
            });
        } else if (absolutePath) {
            void openPath(absolutePath);
        }
    }, [
        menu.kind,
        menu.target,
        vaultEntry,
        absolutePath,
        fileName,
        insertExternalTab,
    ]);

    const menuEntries: ContextMenuEntry[] = useMemo(() => {
        const items: ContextMenuEntry[] = [
            { label: "Open", action: handleOpen },
            { label: "Open in New Tab", action: handleOpenNewTab },
            { type: "separator" },
            {
                label: "Open Externally",
                action: () => {
                    if (absolutePath) void openPath(absolutePath);
                },
                disabled: !absolutePath,
            },
            {
                label: "Reveal in Finder",
                action: () => {
                    if (absolutePath) void revealItemInDir(absolutePath);
                },
                disabled: !absolutePath,
            },
            { type: "separator" },
            {
                label: "Copy Path",
                action: () => {
                    void navigator.clipboard.writeText(menu.target);
                },
            },
        ];
        return items;
    }, [handleOpen, handleOpenNewTab, absolutePath, menu.target]);

    return <ContextMenu menu={menu} entries={menuEntries} onClose={onClose} />;
}
