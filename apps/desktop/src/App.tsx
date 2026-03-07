import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppLayout } from "./components/layout/AppLayout";
import { ActivityBar, type SidebarView } from "./components/layout/ActivityBar";
import { StatusBar } from "./components/layout/StatusBar";
import { FileTree } from "./features/vault/FileTree";
import { UnifiedBar } from "./features/editor/UnifiedBar";
import { Editor } from "./features/editor/Editor";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    getCurrentWindowLabel,
    getWindowMode,
    readDetachedWindowPayload,
} from "./app/detachedWindows";
import { useEditorStore } from "./app/store/editorStore";
import { useVaultStore } from "./app/store/vaultStore";

function SidebarPanel({ view }: { view: SidebarView }) {
    if (view === "files") return <FileTree />;
    if (view === "search") {
        return (
            <div
                className="h-full flex items-center justify-center text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                Search (coming soon)
            </div>
        );
    }
    return (
        <div
            className="h-full flex items-center justify-center text-xs"
            style={{ color: "var(--text-secondary)" }}
        >
            AI Chat (coming soon)
        </div>
    );
}

export default function App() {
    const [sidebarView, setSidebarView] = useState<SidebarView>("files");
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const windowMode = getWindowMode();

    useEffect(() => {
        if (windowMode === "main") {
            void restoreVault();
            return;
        }

        const payload = readDetachedWindowPayload(getCurrentWindowLabel());
        if (payload) {
            hydrateTabs(payload.tabs, payload.activeTabId);
        }
    }, [hydrateTabs, restoreVault, windowMode]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;

        void getCurrentWindow()
            .listen<AttachExternalTabPayload>(
                ATTACH_EXTERNAL_TAB_EVENT,
                (event) => {
                    insertExternalTab(event.payload.tab);
                },
            )
            .then((cleanup) => {
                unlisten = cleanup;
            });

        return () => {
            if (unlisten) {
                void unlisten();
            }
        };
    }, [insertExternalTab]);

    if (windowMode === "note") {
        return (
            <div className="h-full flex flex-col overflow-hidden">
                <UnifiedBar windowMode="note" />
                <div className="flex-1 overflow-hidden">
                    <Editor emptyStateMessage="Esta ventana no tiene ninguna nota abierta" />
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Barra unificada: traffic lights + tabs */}
            <UnifiedBar windowMode="main" />

            {/* Cuerpo: activity bar + layout con paneles */}
            <div className="flex-1 flex overflow-hidden">
                <ActivityBar active={sidebarView} onChange={setSidebarView} />
                <div className="flex-1 overflow-hidden">
                    <AppLayout
                        left={<SidebarPanel view={sidebarView} />}
                        center={<Editor />}
                    />
                </div>
            </div>

            {/* Barra de estado */}
            <StatusBar />
        </div>
    );
}
