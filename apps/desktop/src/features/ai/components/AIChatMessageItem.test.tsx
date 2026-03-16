import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../../test/test-utils";
import type { AIChatMessage } from "../types";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { AIChatMessageItem } from "./AIChatMessageItem";

const pillMetrics = {
    fontSize: 12,
    lineHeight: 1.3,
    paddingX: 8,
    paddingY: 2,
    radius: 8,
    gapX: 2,
    maxWidth: 180,
    offsetY: 0,
};

function renderMessage(
    message: AIChatMessage,
    options: { visibleWorkCycleId?: string | null } = {},
) {
    return renderComponent(
        <AIChatMessageItem
            message={message}
            pillMetrics={pillMetrics}
            visibleWorkCycleId={options.visibleWorkCycleId}
        />,
    );
}

function createDiffMessage(
    id: string,
    diff: NonNullable<AIChatMessage["diffs"]>[number],
): AIChatMessage {
    return {
        id,
        role: "assistant",
        kind: "tool",
        title: "Edit file",
        content: `Updated ${diff.path.split("/").pop() ?? diff.path}`,
        timestamp: Date.now(),
        diffs: [diff],
        meta: {
            tool: "edit",
            status: "completed",
            target: diff.path,
        },
    };
}

beforeEach(() => {
    localStorage.clear();
    resetChatStore();
});

describe("AIChatMessageItem plan message", () => {
    it("renders the plan as a collapsible panel with done status", () => {
        renderMessage({
            id: "plan:1",
            role: "assistant",
            kind: "plan",
            title: "Plan",
            content: "Review state\nShip UI",
            timestamp: Date.now(),
            planEntries: [
                {
                    content: "Review state",
                    priority: "medium",
                    status: "completed",
                },
                {
                    content: "Ship UI",
                    priority: "medium",
                    status: "completed",
                },
            ],
        });

        const button = screen.getByRole("button", { name: /plan/i });
        expect(button).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("All Done")).toBeInTheDocument();
        expect(screen.getByText("Review state")).toHaveStyle(
            "text-decoration: line-through",
        );
    });

    it("collapses and expands the plan body", () => {
        renderMessage({
            id: "plan:2",
            role: "assistant",
            kind: "plan",
            title: "Plan",
            content: "Inspect\nImplement",
            timestamp: Date.now(),
            planDetail: "Summary",
            planEntries: [
                {
                    content: "Inspect",
                    priority: "medium",
                    status: "completed",
                },
                {
                    content: "Implement",
                    priority: "medium",
                    status: "in_progress",
                },
            ],
        });

        const button = screen.getByRole("button", { name: /plan/i });
        expect(screen.getByText("Inspect")).toBeInTheDocument();
        expect(screen.getByText("Summary")).toBeInTheDocument();

        fireEvent.click(button);

        expect(button).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Inspect")).not.toBeInTheDocument();
        expect(screen.queryByText("Summary")).not.toBeInTheDocument();

        fireEvent.click(button);

        expect(button).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Inspect")).toBeInTheDocument();
        expect(screen.getByText("Summary")).toBeInTheDocument();
    });
});

describe("AIChatMessageItem tool diffs", () => {
    it("renders tool diffs in the shared change panel without permission actions", () => {
        setVaultNotes([
            {
                id: "watcher-note",
                path: "/vault/notes/watcher.md",
                title: "watcher",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderMessage({
            id: "tool:1",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.md",
            timestamp: Date.now(),
            workCycleId: "cycle-1",
            diffs: [
                {
                    path: "/vault/notes/watcher.md",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/notes/watcher.md",
            },
        });

        expect(screen.getByText("Edit 1 file")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open File" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("Reject")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /watcher.md/i }));

        expect(screen.getByText(/old line/)).toBeInTheDocument();
        expect(screen.getByText(/new line/)).toBeInTheDocument();
    });

    it("renders exact hunk gutters when diff metadata is available", () => {
        renderMessage({
            id: "tool:exact",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.rs",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "legacy old",
                    new_text: "legacy new",
                    hunks: [
                        {
                            old_start: 12,
                            old_count: 2,
                            new_start: 12,
                            new_count: 2,
                            lines: [
                                { type: "context", text: "shared line" },
                                { type: "remove", text: "old line" },
                                { type: "add", text: "new line" },
                            ],
                        },
                    ],
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });

        fireEvent.click(screen.getByRole("button", { name: /watcher.rs/i }));

        expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("13").length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText("+ old line")).not.toBeInTheDocument();
        expect(screen.queryByText("- new line")).not.toBeInTheDocument();
        expect(screen.getByText("shared line")).toBeInTheDocument();
        expect(screen.getByText("old line")).toBeInTheDocument();
        expect(screen.getByText("new line")).toBeInTheDocument();
    });

    it("hides Open File when the diff target is not an openable note", () => {
        renderMessage({
            id: "tool:non-note",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.rs",
            timestamp: Date.now(),
            workCycleId: "cycle-1",
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });

        expect(screen.getByText("Edit 1 file")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Open File" }),
        ).not.toBeInTheDocument();
    });

    it("hides diff review panels for non-visible work cycles", () => {
        renderMessage(
            {
                id: "tool:hidden",
                role: "assistant",
                kind: "tool",
                title: "Edit watcher",
                content: "Updated watcher.rs",
                timestamp: Date.now(),
                workCycleId: "cycle-old",
                diffs: [
                    {
                        path: "/vault/src/watcher.rs",
                        kind: "update",
                        old_text: "old line",
                        new_text: "new line",
                    },
                ],
                meta: {
                    tool: "edit",
                    status: "completed",
                    target: "/vault/src/watcher.rs",
                },
            },
            { visibleWorkCycleId: "cycle-new" },
        );

        expect(screen.queryByText("Edit 1 file")).not.toBeInTheDocument();
        expect(screen.getByText("watcher.rs")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Open File" }),
        ).not.toBeInTheDocument();
    });

    it("keeps tool messages without diffs on the simple file card", () => {
        renderMessage({
            id: "tool:2",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.rs",
            timestamp: Date.now(),
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });

        expect(screen.getByText("watcher.rs")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Open File" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("Edit 1 file")).not.toBeInTheDocument();
    });

    it("preserves permission actions for permission messages with diffs", () => {
        renderMessage({
            id: "permission:1",
            role: "assistant",
            kind: "permission",
            title: "Permission request",
            content: "Edit watcher",
            timestamp: Date.now(),
            permissionRequestId: "req-1",
            permissionOptions: [
                {
                    option_id: "reject_once",
                    name: "Reject",
                    kind: "reject_once",
                },
                {
                    option_id: "allow_once",
                    name: "Allow once",
                    kind: "allow_once",
                },
            ],
            diffs: [
                {
                    path: "/vault/src/watcher.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                },
            ],
            meta: {
                status: "pending",
                target: "/vault/src/watcher.rs",
            },
        });

        expect(screen.getByText("Edit 1 file")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Allow once" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Open File" }),
        ).not.toBeInTheDocument();
    });

    it("labels moved files without showing a fake textual diff", () => {
        renderMessage(
            createDiffMessage("tool:move", {
                path: "/vault/archive/final.md",
                previous_path: "/vault/notes/draft.md",
                kind: "move",
                old_text: "same content",
                new_text: "same content",
            }),
        );

        expect(screen.getByText("Edit 1 file")).toBeInTheDocument();
        expect(screen.getByText("moved from draft.md")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /final.md/i }));

        expect(
            screen.queryByTestId("diff-content:/vault/archive/final.md"),
        ).not.toBeInTheDocument();
    });

    it("marks non-reversible deletes as partial instead of showing fake deleted content", () => {
        renderMessage(
            createDiffMessage("tool:delete", {
                path: "/vault/archive/deleted.md",
                kind: "delete",
                reversible: false,
                old_text: "[file deleted]",
                new_text: null,
            }),
        );

        expect(screen.getByText("partial")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /deleted.md/i }));

        expect(
            screen.getByText("(partial preview — delete snapshot unavailable)"),
        ).toBeInTheDocument();
        expect(screen.queryByText("[file deleted]")).not.toBeInTheDocument();
    });

    it("uses a large-file preview for big updated files without truncating at 700 lines", () => {
        const oldText = Array.from({ length: 1200 }, (_, idx) =>
            idx === 1100 ? `old changed ${idx}` : `shared ${idx}`,
        ).join("\n");
        const newText = Array.from({ length: 1200 }, (_, idx) =>
            idx === 1100 ? `new changed ${idx}` : `shared ${idx}`,
        ).join("\n");

        renderMessage({
            id: "tool:large-preview",
            role: "assistant",
            kind: "tool",
            title: "Edit giant file",
            content: "Updated giant.md",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/giant.md",
                    kind: "update",
                    old_text: oldText,
                    new_text: newText,
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/giant.md",
            },
        });

        expect(screen.getAllByText("+~1")).toHaveLength(2);
        expect(screen.getAllByText("-~1")).toHaveLength(2);

        fireEvent.click(screen.getByRole("button", { name: /giant.md/i }));

        expect(screen.getByText("shared 1199")).toBeInTheDocument();
        expect(screen.getByText(/large file preview/i)).toBeInTheDocument();
        expect(screen.queryByText(/truncated/i)).not.toBeInTheDocument();
    });

    it("renders zoom controls and updates the expanded diff font size", () => {
        renderMessage(
            createDiffMessage("tool:zoom", {
                path: "/vault/src/watcher.rs",
                kind: "update",
                old_text: "old line",
                new_text: "new line",
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: /watcher.rs/i }));

        const diffContent = screen.getByTestId(
            "diff-content:/vault/src/watcher.rs",
        );
        expect(diffContent).toHaveStyle({ fontSize: "0.72em" });

        fireEvent.click(
            screen.getByRole("button", { name: "Increase diff zoom" }),
        );

        expect(diffContent).toHaveStyle({ fontSize: "0.76em" });
        expect(
            screen.queryByLabelText("Diff zoom level"),
        ).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: "Decrease diff zoom" }),
        );

        expect(diffContent).toHaveStyle({ fontSize: "0.72em" });
    });

    it("disables zoom controls at the configured min and max", () => {
        act(() => {
            useChatStore.setState({ editDiffZoom: 0.64 });
        });
        const { rerender } = renderComponent(
            <AIChatMessageItem
                message={createDiffMessage("tool:min", {
                    path: "/vault/src/min.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                })}
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Decrease diff zoom" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Increase diff zoom" }),
        ).not.toBeDisabled();

        act(() => {
            useChatStore.setState({ editDiffZoom: 0.96 });
        });
        rerender(
            <AIChatMessageItem
                message={createDiffMessage("tool:max", {
                    path: "/vault/src/max.rs",
                    kind: "update",
                    old_text: "old line",
                    new_text: "new line",
                })}
                pillMetrics={pillMetrics}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Increase diff zoom" }),
        ).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Decrease diff zoom" }),
        ).not.toBeDisabled();
    });

    it("shares the persisted diff zoom across multiple edit cards", () => {
        renderComponent(
            <>
                <AIChatMessageItem
                    message={createDiffMessage("tool:first", {
                        path: "/vault/src/first.rs",
                        kind: "update",
                        old_text: "old first",
                        new_text: "new first",
                    })}
                    pillMetrics={pillMetrics}
                />
                <AIChatMessageItem
                    message={createDiffMessage("tool:second", {
                        path: "/vault/src/second.rs",
                        kind: "update",
                        old_text: "old second",
                        new_text: "new second",
                    })}
                    pillMetrics={pillMetrics}
                />
            </>,
        );

        fireEvent.click(
            screen.getAllByRole("button", { name: "Increase diff zoom" })[0],
        );
        fireEvent.click(screen.getByRole("button", { name: /first.rs/i }));
        fireEvent.click(screen.getByRole("button", { name: /second.rs/i }));

        expect(
            screen.getByTestId("diff-content:/vault/src/first.rs"),
        ).toHaveStyle({ fontSize: "0.76em" });
        expect(
            screen.getByTestId("diff-content:/vault/src/second.rs"),
        ).toHaveStyle({ fontSize: "0.76em" });
    });
});

describe("AIChatMessageItem user mention pills", () => {
    it("opens the mention context menu in a new tab", async () => {
        setVaultNotes([
            {
                id: "notes/alpha.md",
                title: "Alpha",
                path: "/vault/notes/alpha.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "notes/alpha.md",
                title: "Alpha",
                content: "# Alpha",
            },
        ]);

        renderMessage({
            id: "user:1",
            role: "user",
            kind: "text",
            content: "Use @Alpha",
            timestamp: Date.now(),
        });

        fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }), {
            clientX: 24,
            clientY: 36,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });
});

describe("AIChatMessageItem read tool targets", () => {
    it("opens read target pills in a new tab from the context menu", async () => {
        setVaultNotes([
            {
                id: "docs/capitulo-2-primer-desfase-visible.md",
                title: "capitulo-2-primer-desfase-visible",
                path: "/vault/docs/capitulo-2-primer-desfase-visible.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "docs/capitulo-2-primer-desfase-visible.md",
                title: "capitulo-2-primer-desfase-visible",
                content: "# Capitulo 2",
            },
        ]);

        renderMessage({
            id: "tool:read-context",
            role: "assistant",
            kind: "tool",
            title: "Read note",
            content: "Read capitulo-2-primer-desfase-visible.md",
            timestamp: Date.now(),
            meta: {
                tool: "read",
                status: "completed",
                target: "/vault/docs/capitulo-2-primer-desfase-visible.md",
            },
        });

        fireEvent.contextMenu(
            screen.getByText("capitulo-2-primer-desfase-visible.md"),
            {
                clientX: 32,
                clientY: 36,
            },
        );
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });
});
