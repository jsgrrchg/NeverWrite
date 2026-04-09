import { useCallback, useMemo } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    ContextMenu,
    type ContextMenuEntry,
} from "../../components/context-menu/ContextMenu";
import {
    getVaultEmbedAbsolutePath,
    openVaultEmbedTarget,
} from "./embedNavigation";

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
    const absolutePath = useMemo(
        () => getVaultEmbedAbsolutePath(menu.target),
        [menu.target],
    );

    const handleOpen = useCallback(() => {
        void openVaultEmbedTarget(menu.target, menu.kind);
    }, [menu.target, menu.kind]);

    const handleOpenNewTab = useCallback(() => {
        void openVaultEmbedTarget(menu.target, menu.kind, { newTab: true });
    }, [menu.target, menu.kind]);

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
