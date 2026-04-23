import type { ContextMenuEntry } from "../../components/context-menu/ContextMenu";
import { inferFileViewer } from "../../app/store/editorTabs";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { createNewChatInWorkspace } from "../ai/chatPaneMovement";
import { useChatStore } from "../ai/store/chatStore";

interface SavedVaultFileDetail {
    path: string;
    relative_path: string;
    file_name: string;
    mime_type: string | null;
    content: string;
    size_bytes?: number | null;
    content_truncated?: boolean | null;
}

function getNextUntitledNoteName() {
    const notes = useVaultStore.getState().notes;
    let name = "Untitled";
    let index = 1;

    while (
        notes.some((note) => note.id === name || note.id.endsWith(`/${name}`))
    ) {
        name = `Untitled ${index++}`;
    }

    return name;
}

function getNextBlankFilePath() {
    const entries = useVaultStore.getState().entries;
    const usedPaths = new Set(
        entries.map((entry) => entry.relative_path.toLowerCase()),
    );

    let relativePath = "untitled";
    let index = 1;

    while (usedPaths.has(relativePath.toLowerCase())) {
        relativePath = `untitled-${index++}`;
    }

    return relativePath;
}

async function createNewNote(paneId?: string) {
    const vault = useVaultStore.getState();
    if (!vault.vaultPath) return;

    try {
        const note = await vault.createNote(getNextUntitledNoteName());
        if (!note) return;

        const editor = useEditorStore.getState();
        if (paneId) {
            editor.insertExternalTabInPane(
                {
                    id: crypto.randomUUID(),
                    kind: "note",
                    noteId: note.id,
                    title: note.title,
                    content: "",
                },
                paneId,
            );
            return;
        }

        editor.openNote(note.id, note.title, "");
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

async function createNewBlankFile(paneId?: string) {
    const vault = useVaultStore.getState();
    if (!vault.vaultPath) return;

    try {
        const detail = await vaultInvoke<SavedVaultFileDetail>(
            "save_vault_file",
            {
                relativePath: getNextBlankFilePath(),
                content: "",
            },
        );

        try {
            await vault.refreshEntries();
        } catch (error) {
            console.error(
                "Failed to refresh entries after creating a blank file:",
                error,
            );
        }

        const editor = useEditorStore.getState();
        const nextTab = {
            id: crypto.randomUUID(),
            kind: "file" as const,
            relativePath: detail.relative_path,
            title: detail.file_name,
            path: detail.path,
            mimeType: detail.mime_type,
            viewer: inferFileViewer(detail.path, detail.mime_type),
            content: detail.content,
            sizeBytes: detail.size_bytes ?? null,
            contentTruncated: Boolean(detail.content_truncated),
        };

        if (paneId) {
            editor.insertExternalTabInPane(nextTab, paneId);
            return;
        }

        editor.openFile(
            detail.relative_path,
            detail.file_name,
            detail.path,
            detail.content,
            detail.mime_type,
            inferFileViewer(detail.path, detail.mime_type),
            {
                sizeBytes: detail.size_bytes ?? null,
                contentTruncated: Boolean(detail.content_truncated),
            },
        );
    } catch (error) {
        console.error(
            "Failed to create a new blank file from the tab menu:",
            error,
        );
    }
}

function createNewTerminal(paneId?: string) {
    useEditorStore.getState().openTerminal({ paneId });
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
    ];

    if (developerModeEnabled) {
        if (developerTerminalEnabled) {
            entries.push({
                label: "New Terminal",
                action: () => createNewTerminal(paneId),
            });
        }

        entries.push({
            label: "New blank file",
            action: () => {
                void createNewBlankFile(paneId);
            },
        });
    }

    return entries;
}

export async function openNewNoteInPane(paneId?: string) {
    await createNewNote(paneId);
}

export async function openNewAgentInPane(paneId?: string, runtimeId?: string) {
    await createNewChat(runtimeId, paneId);
}
