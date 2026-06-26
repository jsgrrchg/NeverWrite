import {
    isChatTab,
    isChatHistoryTab,
    isFileTab,
    isGraphTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    isTerminalTab,
    type Tab,
} from "../../app/store/editorStore";
import { isSearchTab } from "../search/searchTab";

export type EditorPanelView =
    | "pdf"
    | "file"
    | "search"
    | "ai-review"
    | "ai-chat"
    | "ai-chat-history"
    | "editor"
    | "terminal"
    | "map"
    | "graph";

/**
 * Maps a tab to the panel view used to render it. Shared by the classic
 * single-tab pane content and the stacked-columns renderer so both stay in
 * sync on tab-kind handling.
 */
export function resolveEditorPanelView(tab: Tab | null): EditorPanelView {
    if (!tab) return "editor";
    if (isPdfTab(tab)) return "pdf";
    if (isFileTab(tab)) return "file";
    if (isReviewTab(tab)) return "ai-review";
    if (isChatTab(tab)) return "ai-chat";
    if (isChatHistoryTab(tab)) return "ai-chat-history";
    if (isMapTab(tab)) return "map";
    if (isGraphTab(tab)) return "graph";
    if (isTerminalTab(tab)) return "terminal";
    if (!isNoteTab(tab)) return "editor";
    if (isSearchTab(tab)) return "search";
    return "editor";
}
