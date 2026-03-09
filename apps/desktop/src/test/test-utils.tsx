import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { useCommandStore, type Command } from "../features/command-palette/store/commandStore";
import { useEditorStore, type Tab } from "../app/store/editorStore";
import { useVaultStore, type NoteDto } from "../app/store/vaultStore";

export function renderComponent(ui: ReactElement) {
    return render(ui);
}

export function mockInvoke() {
    return vi.mocked(invoke);
}

export function setEditorTabs(tabs: Tab[], activeTabId: string | null = tabs[0]?.id ?? null) {
    useEditorStore.setState({ tabs, activeTabId });
}

export function setVaultNotes(notes: NoteDto[], vaultPath = "/vault") {
    useVaultStore.setState({ notes, vaultPath });
}

export function setCommands(commands: Command[], activeModal: "command-palette" | "quick-switcher" | null) {
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
    return (globalThis as typeof globalThis & {
        __clipboardMock: {
            writeText: ReturnType<typeof vi.fn>;
            readText: ReturnType<typeof vi.fn>;
        };
    }).__clipboardMock;
}
