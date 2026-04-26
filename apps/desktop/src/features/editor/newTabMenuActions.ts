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
import { createNewChatInWorkspace } from "../ai/chatPaneMovement";
import { useChatStore } from "../ai/store/chatStore";
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

function getRuntimeMenuLabel(name: string) {
    const trimmed = name.trim();
    return trimmed.replace(/ ACP$/, "");
}

async function createNewChat(runtimeId?: string, paneId?: string) {
    try {
        await createNewChatInWorkspace(
            runtimeId,
            paneId ? { paneId } : undefined,
        );
    } catch (error) {
        console.error("Failed to create a new chat from the tab menu:", error);
    }
}

function createNewTerminal(paneId?: string) {
    useEditorStore.getState().openTerminal({ paneId });
}

function openSearch(paneId?: string) {
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
    developerModeEnabled?: boolean;
    developerTerminalEnabled?: boolean;
}): ContextMenuEntry[] {
    const paneId = options?.paneId;
    const developerModeEnabled = options?.developerModeEnabled ?? false;
    const developerTerminalEnabled =
        options?.developerTerminalEnabled ?? false;
    const chatState = useChatStore.getState();
    const runtimes = [...chatState.runtimes];
    const selectedRuntimeId = chatState.selectedRuntimeId;
    runtimes.sort((left, right) => {
        if (left.runtime.id === selectedRuntimeId) return -1;
        if (right.runtime.id === selectedRuntimeId) return 1;
        return left.runtime.name.localeCompare(right.runtime.name);
    });
    const entries: ContextMenuEntry[] = [
        {
            label: "New Note",
            action: () => {
                void createNewNote(paneId);
            },
        },
        {
            label: SEARCH_TAB_TITLE,
            action: () => openSearch(paneId),
        },
        {
            label: "New Agent",
            disabled: runtimes.length === 0,
            children:
                runtimes.length > 0
                    ? runtimes.map((runtime) => ({
                          label: getRuntimeMenuLabel(runtime.runtime.name),
                          action: () => {
                              void createNewChat(runtime.runtime.id, paneId);
                          },
                      }))
                    : [
                          {
                              label: "No providers available",
                              disabled: true,
                          },
                      ],
        },
        {
            label: "Open Graph",
            action: () => openGraph(paneId),
        },
    ];

    if (developerModeEnabled) {
        if (developerTerminalEnabled) {
            entries.push({
                label: "New Terminal",
                action: () => createNewTerminal(paneId),
            });
        }
    }

    return entries;
}

export async function openNewNoteInPane(paneId?: string) {
    await createNewNote(paneId);
}

export async function openNewAgentInPane(paneId?: string, runtimeId?: string) {
    await createNewChat(runtimeId, paneId);
}
