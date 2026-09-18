import {
    useEditorStore,
    isNoteTab,
    selectFocusedEditorTab,
} from "../../app/store/editorStore";
import { AgentsSidebarPanel } from "../../features/ai/AgentsSidebarPanel";
import { BookmarksPanel } from "../../features/bookmarks/BookmarksPanel";
import { MapsPanel } from "../../features/maps/MapsPanel";
import { LinksPanel } from "../../features/notes/LinksPanel";
import { OutlinePanel } from "../../features/notes/OutlinePanel";
import { TagsPanel } from "../../features/tags/TagsPanel";
import { FileTree } from "../../features/vault/FileTree";
import type { SidebarView } from "./sidebarViews";

function OutlineSidebarContent() {
    const activeNoteId = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeContent = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return tab && isNoteTab(tab) ? tab.content : null;
    });
    const queueSelectionReveal = useEditorStore(
        (state) => state.queueSelectionReveal,
    );
    if (!activeNoteId) {
        return (
            <div
                className="flex items-center justify-center h-full text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                No note open
            </div>
        );
    }
    return (
        <OutlinePanel
            content={activeContent}
            onSelectHeading={(selection) =>
                queueSelectionReveal({
                    noteId: activeNoteId,
                    anchor: selection.anchor,
                    head: selection.head,
                })
            }
        />
    );
}

export function SidebarViewContent({ view }: { view: SidebarView }) {
    switch (view) {
        case "files":
            return <FileTree />;
        case "agents":
            return <AgentsSidebarPanel />;
        case "tags":
            return <TagsPanel />;
        case "bookmarks":
            return <BookmarksPanel />;
        case "maps":
            return <MapsPanel />;
        case "outline":
            return <OutlineSidebarContent />;
        case "links":
            return <LinksPanel />;
    }
}
