import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { confirm } from "@neverwrite/runtime";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "../ai/store/chatStore";
import { EditorPaneBar } from "./EditorPaneBar";

function rect({
    left,
    top,
    width,
    height,
}: {
    left: number;
    top: number;
    width: number;
    height: number;
}) {
    return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
    } as DOMRect;
}

function defineElementMetric<T extends keyof HTMLElement>(
    element: HTMLElement,
    property: T,
    value: HTMLElement[T],
) {
    Object.defineProperty(element, property, {
        configurable: true,
        value,
    });
}

function resizeObserverEntry(
    target: Element,
    contentRect: DOMRectReadOnly,
): ResizeObserverEntry {
    return {
        target,
        contentRect,
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
    } as ResizeObserverEntry;
}

function createChatSession(sessionId: string, title: string) {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle" as const,
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message`,
                role: "user" as const,
                kind: "text" as const,
                content: title,
                timestamp: 10,
            },
        ],
        attachments: [],
    };
}

describe("EditorPaneBar", () => {
    beforeEach(() => {
        if (typeof window.PointerEvent === "undefined") {
            class MockPointerEvent extends MouseEvent {
                pointerId: number;
                pointerType: string;
                isPrimary: boolean;

                constructor(
                    type: string,
                    init: MouseEventInit & {
                        pointerId?: number;
                        pointerType?: string;
                        isPrimary?: boolean;
                    } = {},
                ) {
                    super(type, init);
                    this.pointerId = init.pointerId ?? 1;
                    this.pointerType = init.pointerType ?? "mouse";
                    this.isPrimary = init.isPrimary ?? true;
                }
            }

            Object.defineProperty(window, "PointerEvent", {
                configurable: true,
                value: MockPointerEvent,
            });
            Object.defineProperty(globalThis, "PointerEvent", {
                configurable: true,
                value: MockPointerEvent,
            });
        }

        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
            configurable: true,
            value: () => {},
        });
        Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
            configurable: true,
            value: () => {},
        });
        Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
            configurable: true,
            value: () => false,
        });
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-a",
                            kind: "note",
                            noteId: "notes/a",
                            title: "Alpha",
                            content: "Alpha",
                        },
                    ],
                    activeTabId: "tab-a",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "tab-b",
                            kind: "note",
                            noteId: "notes/b",
                            title: "Beta",
                            content: "Beta",
                        },
                    ],
                    activeTabId: "tab-b",
                },
            ],
            "primary",
        );
        useSettingsStore.getState().reset();
        vi.mocked(confirm).mockReset();
        vi.mocked(confirm).mockResolvedValue(true);
    });

    it("shows compact empty-pane chrome when a pane has no tabs", () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        expect(screen.getByText("No tabs open")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Pane 1 actions" }),
        ).toBeInTheDocument();
        expect(
            document.querySelector('[data-pane-empty="true"]'),
        ).not.toBeNull();
    });

    it("shows pane history navigation buttons when open behavior uses history", () => {
        useSettingsStore.getState().setSetting("tabOpenBehavior", "history");

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        expect(screen.getByTitle("Go back")).toBeInTheDocument();
        expect(screen.getByTitle("Go forward")).toBeInTheDocument();
    });

    it("hides pane history navigation buttons when open behavior creates new tabs", () => {
        useSettingsStore.getState().setSetting("tabOpenBehavior", "new_tab");

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        expect(screen.queryByTitle("Go back")).not.toBeInTheDocument();
        expect(screen.queryByTitle("Go forward")).not.toBeInTheDocument();
    });

    it("hides direct pane-target entries from the tab context menu", async () => {
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);

        await screen.findByRole("button", { name: "Move to New Right Split" });

        expect(
            screen.queryByRole("button", { name: "Move to Pane 2" }),
        ).not.toBeInTheDocument();
    });

    it("confirms before closing a tab with an active agent", async () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-chat",
                            kind: "ai-chat",
                            sessionId: "session-busy",
                            title: "Chat",
                        },
                    ],
                    activeTabId: "tab-chat",
                },
            ],
            "primary",
        );
        useChatStore.setState({
            sessionsById: {
                "session-busy": {
                    ...createChatSession("session-busy", "Busy agent"),
                    status: "streaming",
                },
            },
        });
        vi.mocked(confirm).mockResolvedValue(false);

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        fireEvent.click(screen.getByTitle("Close Busy agent"));
        await waitFor(() => {
            expect(confirm).toHaveBeenCalledTimes(1);
        });
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-chat",
        ]);
    });

    it("moves a tab into a new right split from the tab context menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);
        await user.click(
            await screen.findByRole("button", {
                name: "Move to New Right Split",
            }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(2);
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("pane-3");
        expect(state.panes.map((pane) => pane.id)).toEqual([
            "pane-3",
            "secondary",
        ]);
        expect(
            state.panes.find((pane) => pane.id === "pane-3")?.tabs[0],
        ).toMatchObject({
            kind: "note",
            noteId: "notes/a",
            title: "Alpha",
            content: "Alpha",
        });
    });

    it("moves a tab into a new down split under the current pane without flattening sibling panes", async () => {
        const user = userEvent.setup();
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-a",
                            kind: "note",
                            noteId: "notes/a",
                            title: "Alpha",
                            content: "Alpha",
                        },
                        {
                            id: "tab-c",
                            kind: "note",
                            noteId: "notes/c",
                            title: "Gamma",
                            content: "Gamma",
                        },
                    ],
                    activeTabId: "tab-a",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "tab-b",
                            kind: "note",
                            noteId: "notes/b",
                            title: "Beta",
                            content: "Beta",
                        },
                    ],
                    activeTabId: "tab-b",
                },
            ],
            "primary",
        );

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-c"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);
        await user.click(
            await screen.findByRole("button", {
                name: "Move to New Down Split",
            }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(3);
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("pane-3");
        expect(state.panes.map((pane) => pane.id)).toEqual([
            "primary",
            "pane-3",
            "secondary",
        ]);
        expect(
            state.panes
                .find((pane) => pane.id === "primary")
                ?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-a"]);
        expect(
            state.panes
                .find((pane) => pane.id === "pane-3")
                ?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-c"]);
        expect(
            state.panes
                .find((pane) => pane.id === "secondary")
                ?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-b"]);
        expect(state.layoutTree.type).toBe("split");
        if (state.layoutTree.type !== "split") {
            throw new Error("Expected root split layout");
        }
        expect(state.layoutTree.direction).toBe("row");
        const nestedSplit = state.layoutTree.children[0];
        expect(nestedSplit?.type).toBe("split");
        if (!nestedSplit || nestedSplit.type !== "split") {
            throw new Error("Expected nested split on the left branch");
        }
        expect(nestedSplit.direction).toBe("column");
    });

    it("scrolls the pane tab strip horizontally with the mouse wheel", () => {
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabStrip = document.querySelector(
            '[data-pane-tab-strip="primary"]',
        ) as HTMLDivElement | null;
        expect(tabStrip).not.toBeNull();

        let scrollLeft = 12;
        Object.defineProperty(tabStrip!, "scrollLeft", {
            configurable: true,
            get: () => scrollLeft,
            set: (value: number) => {
                scrollLeft = value;
            },
        });

        fireEvent.wheel(tabStrip!, { deltaY: 28 });

        expect(scrollLeft).toBe(40);
    });

    it("activates a tab on pointer release instead of pointer press", () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-a",
                            kind: "note",
                            noteId: "notes/a",
                            title: "Alpha",
                            content: "Alpha",
                        },
                        {
                            id: "tab-c",
                            kind: "note",
                            noteId: "notes/c",
                            title: "Gamma",
                            content: "Gamma",
                        },
                    ],
                    activeTabId: "tab-a",
                },
            ],
            "primary",
        );

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-c"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();

        fireEvent.pointerDown(tabButton!, {
            pointerId: 1,
            button: 0,
            buttons: 1,
            clientX: 120,
            clientY: 18,
            screenX: 120,
            screenY: 18,
        });

        expect(
            useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "primary")?.activeTabId,
        ).toBe("tab-a");

        fireEvent.pointerUp(tabButton!, {
            pointerId: 1,
            button: 0,
            buttons: 0,
            clientX: 120,
            clientY: 18,
            screenX: 120,
            screenY: 18,
        });

        expect(
            useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "primary")?.activeTabId,
        ).toBe("tab-c");
    });

    it("uses the unified bar responsive tab sizing logic in split view", async () => {
        const resizeCallbacks: ResizeObserverCallback[] = [];
        const originalResizeObserver = globalThis.ResizeObserver;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallbacks.push(callback);
            }

            observe() {}

            disconnect() {}
        }

        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: MockResizeObserver,
        });

        try {
            useEditorStore.getState().hydrateWorkspace(
                [
                    {
                        id: "primary",
                        tabs: [
                            {
                                id: "tab-a",
                                kind: "note",
                                noteId: "notes/a",
                                title: "Alpha",
                                content: "Alpha",
                            },
                            {
                                id: "tab-b",
                                kind: "note",
                                noteId: "notes/b",
                                title: "Beta",
                                content: "Beta",
                            },
                            {
                                id: "tab-c",
                                kind: "note",
                                noteId: "notes/c",
                                title: "Gamma",
                                content: "Gamma",
                            },
                        ],
                        activeTabId: "tab-a",
                    },
                ],
                "primary",
            );

            renderComponent(<EditorPaneBar paneId="primary" isFocused />);

            const strip = document.querySelector(
                '[data-pane-tab-strip="primary"]',
            ) as HTMLElement | null;
            const firstTab = document.querySelector(
                '[data-pane-tab-id="tab-a"]',
            ) as HTMLElement | null;

            expect(strip).not.toBeNull();
            expect(firstTab).not.toBeNull();

            defineElementMetric(strip!, "clientWidth", 420);
            defineElementMetric(strip!, "scrollWidth", 480);

            await act(async () => {
                for (const resizeCallback of resizeCallbacks) {
                    resizeCallback(
                        [
                            resizeObserverEntry(
                                strip!,
                                rect({
                                    left: 0,
                                    top: 0,
                                    width: 420,
                                    height: 38,
                                }),
                            ),
                        ],
                        {} as ResizeObserver,
                    );
                }
                await Promise.resolve();
            });

            expect(strip).toHaveAttribute(
                "data-pane-tab-density",
                "comfortable",
            );
            expect(strip).toHaveAttribute("data-pane-tab-overflowing", "true");
            expect(parseFloat(firstTab!.style.width)).toBe(160);

            defineElementMetric(strip!, "clientWidth", 560);
            defineElementMetric(strip!, "scrollWidth", 560);

            await act(async () => {
                for (const resizeCallback of resizeCallbacks) {
                    resizeCallback(
                        [
                            resizeObserverEntry(
                                strip!,
                                rect({
                                    left: 0,
                                    top: 0,
                                    width: 560,
                                    height: 38,
                                }),
                            ),
                        ],
                        {} as ResizeObserver,
                    );
                }
                await Promise.resolve();
            });

            expect(strip).toHaveAttribute(
                "data-pane-tab-density",
                "comfortable",
            );
            expect(parseFloat(firstTab!.style.width)).toBe(160);
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
        }
    });

    it("keeps creating new splits available after many panes already exist", async () => {
        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        await act(async () => {
            Array.from({ length: 6 }, () =>
                useEditorStore.getState().createEmptyPane(),
            );
            await Promise.resolve();
        });

        const tabButton = document.querySelector(
            '[data-pane-tab-id="tab-a"]',
        ) as HTMLElement | null;
        expect(tabButton).not.toBeNull();
        fireEvent.contextMenu(tabButton!);

        expect(
            await screen.findByRole("button", {
                name: "Move to New Right Split",
            }),
        ).toBeEnabled();
    });

    it("does not show split view actions in the pane actions menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        await user.click(
            screen.getByRole("button", { name: "Pane 2 actions" }),
        );

        expect(
            screen.queryByRole("button", { name: "Split Right" }),
        ).toBeNull();
        expect(screen.queryByRole("button", { name: "Split Down" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Focus Pane Left" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Focus Pane Right" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Focus Pane Up" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Focus Pane Down" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Balance Layout" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Unify All Tabs" }),
        ).toBeNull();
        expect(
            await screen.findByRole("button", { name: "Close Pane 2" }),
        ).toBeVisible();
    });

    it("closes a pane explicitly from the pane actions menu", async () => {
        const user = userEvent.setup();
        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        await user.click(
            screen.getByRole("button", { name: "Pane 2 actions" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Close Pane 2" }),
        );

        await waitFor(() => {
            expect(useEditorStore.getState().panes).toHaveLength(1);
        });
        expect(useEditorStore.getState().focusedPaneId).toBe("primary");
    });

    it("does not start renaming workspace chat tabs from a double click on the tab title", async () => {
        useChatStore.setState({
            sessionsById: {
                "session-a": createChatSession("session-a", "Workspace chat"),
            },
        });
        useEditorStore.getState().openChat("session-a", {
            title: "Stale title",
            paneId: "primary",
        });

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        fireEvent.doubleClick(screen.getByText("Workspace chat"));

        expect(screen.queryByDisplayValue("Workspace chat")).toBeNull();
        expect(
            useChatStore.getState().sessionsById["session-a"]?.customTitle ??
                null,
        ).toBeNull();
    });

    it("creates a new note from the pane plus-button context menu in the current pane", async () => {
        const createNote = vi.fn().mockResolvedValue({
            id: "notes/from-menu.md",
            path: "/vault/notes/from-menu.md",
            title: "From Menu",
            modified_at: 1,
            created_at: 1,
        });
        useVaultStore.setState({
            vaultPath: "/vault",
            createNote,
        });

        renderComponent(<EditorPaneBar paneId="primary" isFocused />);

        const newTabButton = document.querySelector(
            '[data-new-tab-button="true"]',
        ) as HTMLElement | null;
        expect(newTabButton).not.toBeNull();

        fireEvent.contextMenu(newTabButton!);
        fireEvent.click(
            await screen.findByRole("button", { name: "New Note" }),
        );

        await waitFor(() => {
            const primaryPane = useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "primary");
            expect(
                primaryPane?.tabs.some(
                    (tab) =>
                        tab.kind === "note" &&
                        tab.noteId === "notes/from-menu.md",
                ),
            ).toBe(true);
        });

        expect(createNote).toHaveBeenCalledTimes(1);
        expect(
            useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "secondary")
                ?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-b"]);
    });

    it("creates a workspace terminal from the pane plus-button context menu", async () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        useSettingsStore.setState({
            developerModeEnabled: true,
            developerTerminalEnabled: true,
        });

        renderComponent(<EditorPaneBar paneId="secondary" isFocused />);

        const newTabButton = document.querySelector(
            '[data-new-tab-button="true"]',
        ) as HTMLElement | null;
        expect(newTabButton).not.toBeNull();

        fireEvent.contextMenu(newTabButton!);
        fireEvent.click(
            await screen.findByRole("button", { name: "New Terminal" }),
        );

        await waitFor(() => {
            const secondaryPane = useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "secondary");
            expect(
                secondaryPane?.tabs.some((tab) => tab.kind === "terminal"),
            ).toBe(true);
            expect(secondaryPane?.activeTabId).toBe(
                secondaryPane?.tabs.find((tab) => tab.kind === "terminal")?.id,
            );
        });

        expect(
            useEditorStore
                .getState()
                .panes.find((pane) => pane.id === "primary")
                ?.tabs.map((tab) => tab.id),
        ).toEqual(["tab-a"]);
    });
});
