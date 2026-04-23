import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import {
    useCommandStore,
    type Command,
} from "../features/command-palette/store/commandStore";
import { useEditorStore, type TabInput } from "../app/store/editorStore";
import {
    useVaultStore,
    type NoteDto,
    type VaultEntryDto,
} from "../app/store/vaultStore";

export function renderComponent(ui: ReactElement) {
    return render(ui);
}

export function mockInvoke() {
    return vi.mocked(invoke);
}

export function setEditorTabs(
    tabs: TabInput[],
    activeTabId: string | null = tabs[0]?.id ?? null,
) {
    useEditorStore.getState().hydrateTabs(tabs, activeTabId);
    useEditorStore.setState({
        activeTabId,
        activationHistory: activeTabId ? [activeTabId] : [],
        tabNavigationHistory: activeTabId ? [activeTabId] : [],
        tabNavigationIndex: activeTabId ? 0 : -1,
        _pendingForceReloads: new Set<string>(),
        _pendingForceFileReloads: new Set<string>(),
        _noteReloadVersions: {},
        _fileReloadVersions: {},
        _noteReloadMetadata: {},
        _fileReloadMetadata: {},
        dirtyTabIds: new Set<string>(),
        noteExternalConflicts: new Set<string>(),
        fileExternalConflicts: new Set<string>(),
    });
}

export function setVaultNotes(notes: NoteDto[], vaultPath = "/vault") {
    useVaultStore.setState((state) => ({
        notes,
        vaultPath,
        vaultRevision: state.vaultRevision + 1,
        structureRevision: state.structureRevision + 1,
    }));
}

export function setVaultEntries(
    entries: VaultEntryDto[],
    vaultPath = "/vault",
) {
    useVaultStore.setState((state) => ({
        entries,
        vaultPath,
        vaultRevision: state.vaultRevision + 1,
        structureRevision: state.structureRevision + 1,
    }));
}

export function setCommands(
    commands: Command[],
    activeModal: "command-palette" | "quick-switcher" | null,
) {
    useCommandStore.setState({
        commands: new Map(commands.map((command) => [command.id, command])),
        activeModal,
    });
}

export function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

export async function flushPromises() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

export function getClipboardMock() {
    return (
        globalThis as typeof globalThis & {
            __clipboardMock: {
                writeText: ReturnType<typeof vi.fn>;
                readText: ReturnType<typeof vi.fn>;
            };
        }
    ).__clipboardMock;
}

export function getXtermMockInstances() {
    return (
        globalThis as typeof globalThis & {
            __xtermMockInstances: Array<{
                emitData: (data: string) => void;
                focusCalls: number;
            }>;
        }
    ).__xtermMockInstances;
}
