import type { ContextMenuEntry } from "../../components/context-menu/ContextMenu";
import {
    createGraphTab,
    createNoteTab,
    isGraphTab,
} from "../../app/store/editorTabs";
import {
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import {
    canCreateClaudeCodeAgent,
    createCanonicalAgent,
    createClaudeCodeAgent,
} from "../ai/newAgentCreation";
import {
    isSearchTab,
    SEARCH_NOTE_ID,
    SEARCH_TAB_TITLE,
} from "../search/searchTab";
import { openUntitledMarkdownNote } from "./markdownNoteCreation";

async function createNewNote(paneId?: string) {
    try {
        await openUntitledMarkdownNote(paneId);
    } catch (error) {
        console.error("Failed to create a new note from the tab menu:", error);
    }
}

async function createNewAgent(paneId?: string) {
    try {
        await createCanonicalAgent(paneId);
    } catch (error) {
        console.error("Failed to create a new chat from the tab menu:", error);
    }
}

function createNewTerminal(paneId?: string) {
    useEditorStore.getState().openTerminal({ paneId });
}

export function openSearchInWorkspace(paneId?: string) {
    const editor = useEditorStore.getState();
    const targetPane =
        (paneId
            ? editor.panes.find((pane) => pane.id === paneId)
            : selectEditorPaneState(editor)) ?? selectEditorPaneState(editor);
    const existingSearchTab = targetPane.tabs.find(isSearchTab);

    if (existingSearchTab) {
        editor.switchTab(existingSearchTab.id);
        return;
    }

    editor.insertExternalTabInPane(
        createNoteTab(SEARCH_NOTE_ID, SEARCH_TAB_TITLE, ""),
        targetPane.id,
    );
}

function openGraph(paneId?: string) {
    const editor = useEditorStore.getState();
    const existingGraphTab = selectEditorWorkspaceTabs(editor).find(isGraphTab);
    if (existingGraphTab || !paneId) {
        editor.openGraph();
        return;
    }

    const paneExists = editor.panes.some((pane) => pane.id === paneId);
    if (!paneExists) {
        editor.openGraph();
        return;
    }

    editor.insertExternalTabInPane(createGraphTab(), paneId);
}

export function buildNewTabContextMenuEntries(options?: {
    paneId?: string;
}): ContextMenuEntry[] {
    const paneId = options?.paneId;
    const entries: ContextMenuEntry[] = [
        {
            label: "New Note",
            action: () => {
                void createNewNote(paneId);
            },
        },
        {
            label: SEARCH_TAB_TITLE,
            action: () => openSearchInWorkspace(paneId),
        },
        {
            label: "New Agent",
            action: () => {
                void createNewAgent(paneId);
            },
        },
        {
            label: "Open Graph",
            action: () => openGraph(paneId),
        },
    ];

    if (canCreateClaudeCodeAgent()) {
        entries.splice(3, 0, {
            label: "Claude Code",
            action: () => {
                void createClaudeCodeAgent(paneId);
            },
        });
    }

    entries.push({
        label: "New Terminal",
        action: () => createNewTerminal(paneId),
    });

    return entries;
}

export async function openNewNoteInPane(paneId?: string) {
    await createNewNote(paneId);
}

export async function openNewAgentInPane(paneId?: string) {
    await createNewAgent(paneId);
}
