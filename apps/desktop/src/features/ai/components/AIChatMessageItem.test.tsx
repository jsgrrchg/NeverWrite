import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke, openPath, revealItemInDir } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    getClipboardMock,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../../test/test-utils";
import type { AIChatMessage, AIUserInputAction } from "../types";
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
    options: {
        sessionId?: string | null;
        visibleWorkCycleId?: string | null;
        onUserInputResponse?: (
            requestId: string,
            answers: Record<string, string[]>,
            action?: AIUserInputAction,
        ) => void;
        onDismissMessage?: (messageId: string) => void;
    } = {},
) {
    return renderComponent(
        <AIChatMessageItem
            message={message}
            sessionId={options.sessionId}
            pillMetrics={pillMetrics}
            visibleWorkCycleId={options.visibleWorkCycleId}
            onUserInputResponse={options.onUserInputResponse}
            onDismissMessage={options.onDismissMessage}
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

function getChangeReviewRail(path: string) {
    const rail = document.querySelector<HTMLElement>(
        `[data-change-review-path="${path}"]`,
    );
    if (!rail) {
        throw new Error(`Expected a change review rail for ${path}.`);
    }
    return rail;
}

function expectChangeReviewRail(path: string, action = "Edited") {
    const rail = getChangeReviewRail(path);
    expect(
        rail.querySelector("[data-change-review-operation-icon]"),
    ).not.toBeNull();
    expect(rail.querySelector("[data-change-review-file-icon]")).toBeNull();
    expect(within(rail).getByText(action)).toBeInTheDocument();
    expect(
        within(rail).getByText(path.split("/").at(-1) ?? path),
    ).toBeInTheDocument();
    return rail;
}

function expandChangeReviewRail(path: string) {
    const rail = getChangeReviewRail(path);
    fireEvent.click(
        within(rail).getByRole("button", {
            name: "Expand inline diff review",
        }),
    );
    return rail;
}

beforeEach(() => {
    localStorage.clear();
    resetChatStore();
    useSettingsStore.setState({ lineWrapping: true });
    useEditorStore.setState({
        tabs: [],
        activeTabId: null,
        pendingLineReveal: null,
    });
});

describe("AIChatMessageItem errors", () => {
    it("renders a dismiss action for non-readonly error messages", () => {
        const onDismissMessage = vi.fn();

        renderMessage(
            {
                id: "error:1",
                role: "assistant",
                kind: "error",
                content: "Could not reconnect this chat.",
                timestamp: Date.now(),
            },
            { onDismissMessage },
        );

        fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

        expect(onDismissMessage).toHaveBeenCalledWith("error:1");
    });
});

describe("AIChatMessageItem assistant references", () => {
    it("uses the icon-led link appearance for assistant file references", () => {
        setVaultEntries([
            {
                id: "src/main.ts",
                path: "/vault/src/main.ts",
                relative_path: "src/main.ts",
                title: "main.ts",
                file_name: "main.ts",
                extension: "ts",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 32,
                mime_type: "text/typescript",
            },
        ]);

        renderMessage({
            content: "Read [main.ts](src/main.ts).",
            id: "assistant:file-reference",
            kind: "text",
            role: "assistant",
            timestamp: Date.now(),
        });

        const reference = screen.getByRole("button", { name: "main.ts" });
        expect(reference).toHaveStyle({
            background: "transparent",
            padding: "0px",
        });
        expect(reference.querySelector("svg")).not.toBeNull();
    });
});

describe("AIChatMessageItem reasoning", () => {
    it("renders reasoning with the same compact activity language", () => {
        renderMessage({
            content: "Checking source reliability",
            id: "thinking:1",
            kind: "thinking",
            role: "assistant",
            timestamp: Date.now(),
            title: "Thinking",
        });

        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        expect(
            document.querySelector("[data-reasoning-activity]"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Checking source reliability"),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));

        expect(
            screen.getByText("Checking source reliability"),
        ).toBeInTheDocument();
    });
});

describe("AIChatMessageItem user input", () => {
    it("submits all selected options for multi-select questions", () => {
        const onUserInputResponse = vi.fn();

        renderMessage(
            {
                id: "user-input:input-1",
                role: "assistant",
                kind: "user_input_request",
                title: "Choose targets",
                content: "Choose the files to include.",
                timestamp: Date.now(),
                userInputRequestId: "input-1",
                userInputQuestions: [
                    {
                        id: "targets",
                        header: "Targets",
                        question: "Which files should I include?",
                        is_other: false,
                        is_secret: false,
                        allows_multiple: true,
                        options: [
                            {
                                label: "README.md",
                                value: "readme",
                                description: "Project overview",
                                preview: "docs/README.md",
                            },
                            {
                                label: "CHANGELOG.md",
                                value: "changelog",
                                description: "Release history",
                            },
                        ],
                    },
                ],
                meta: {
                    status: "pending",
                },
            },
            { sessionId: "session-1", onUserInputResponse },
        );

        expect(screen.getByText("Project overview")).toBeInTheDocument();
        expect(screen.queryByText("docs/README.md")).not.toBeInTheDocument();

        const readmeOption = screen.getByRole("button", {
            name: /README\.md/,
        });
        fireEvent.focus(readmeOption);
        expect(screen.getByText("docs/README.md")).toBeInTheDocument();
        fireEvent.blur(readmeOption);
        expect(screen.queryByText("docs/README.md")).not.toBeInTheDocument();

        fireEvent.click(readmeOption);
        fireEvent.click(screen.getByRole("button", { name: /CHANGELOG\.md/ }));
        fireEvent.click(screen.getByRole("button", { name: "Submit" }));

        expect(screen.getByText("docs/README.md")).toBeInTheDocument();
        expect(onUserInputResponse).toHaveBeenCalledWith(
            "input-1",
            {
                targets: ["readme", "changelog"],
            },
            "accept",
        );
    });

    it("submits per-question custom answers instead of the selected option", () => {
        const onUserInputResponse = vi.fn();

        renderMessage(
            {
                id: "user-input:input-custom",
                role: "assistant",
                kind: "user_input_request",
                title: "Choose an approach",
                content: "Pick or type another approach.",
                timestamp: Date.now(),
                userInputRequestId: "input-custom",
                userInputQuestions: [
                    {
                        id: "question_0",
                        custom_answer_id: "question_0_custom",
                        header: "Approach",
                        question: "Which approach should I use?",
                        is_other: true,
                        is_secret: false,
                        options: [
                            {
                                label: "Safe",
                                value: "safe",
                                description: "Use the narrow scope.",
                            },
                        ],
                    },
                ],
                meta: {
                    status: "pending",
                },
            },
            { sessionId: "session-1", onUserInputResponse },
        );

        fireEvent.click(screen.getByRole("button", { name: /Safe/ }));
        fireEvent.change(screen.getByLabelText("Other"), {
            target: { value: "Use my custom approach" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Submit" }));

        expect(onUserInputResponse).toHaveBeenCalledWith(
            "input-custom",
            {
                question_0: ["safe"],
                question_0_custom: ["Use my custom approach"],
            },
            "accept",
        );
    });
});

describe("AIChatMessageItem generated images", () => {
    it("renders an in-progress generated image placeholder", () => {
        renderMessage({
            id: "image:1",
            role: "assistant",
            kind: "image",
            title: "Generating image",
            content: "Generating image...",
            timestamp: Date.now(),
            inProgress: true,
            meta: {
                image_status: "in_progress",
            },
        });

        expect(screen.getByText("Generating image...")).toBeInTheDocument();
    });

    it("renders a generated image preview with file actions", () => {
        const imagePath =
            "/Users/test/.codex/generated_images/session/ig_1.png";

        renderMessage({
            id: "image:1",
            role: "assistant",
            kind: "image",
            title: "Generated image",
            content: "Generated image",
            timestamp: Date.now(),
            meta: {
                image_status: "completed",
                image_path: imagePath,
                revised_prompt: "A tiny blue square",
            },
        });

        const image = screen.getByRole("img", {
            name: "A tiny blue square",
        });
        expect(image.getAttribute("src")).toContain(
            "neverwrite-file://localhost/codex-image/",
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Open Externally" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Reveal in Finder" }),
        );

        expect(openPath).toHaveBeenCalledWith(imagePath);
        expect(revealItemInDir).toHaveBeenCalledWith(imagePath);
    });
});

describe("AIChatMessageItem user image attachments", () => {
    it("uses Comando's responsive user bubble width", () => {
        const view = renderMessage({
            id: "user:compact-bubble",
            role: "user",
            kind: "text",
            content: "Keep this compact",
            timestamp: Date.now(),
        });

        expect(
            view.container.querySelector("[data-user-message]"),
        ).toHaveClass("w-full");
        expect(
            view.container.querySelector("[data-user-message-bubble]"),
        ).toHaveClass("ml-auto", "w-[70%]", "max-w-full");
        expect(
            view.container.querySelector("[data-user-message-bubble]"),
        ).toHaveAttribute(
            "style",
            expect.stringContaining(
                "background-color: color-mix(in srgb, var(--accent) 5%, var(--bg-tertiary))",
            ),
        );
        expect(
            view.container.querySelector("[data-user-message-bubble]"),
        ).toHaveAttribute(
            "style",
            expect.stringContaining(
                "border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
            ),
        );
    });

    it("shows sent time and copies the user message", async () => {
        const timestamp = Date.parse("2026-07-11T15:42:00Z");
        const view = renderMessage({
            id: "user:copy",
            role: "user",
            kind: "text",
            content: "Copy this prompt",
            timestamp,
        });

        expect(
            view.container.querySelector("[data-user-message-metadata] time"),
        ).toHaveAttribute("dateTime", new Date(timestamp).toISOString());

        fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

        await waitFor(() => {
            expect(getClipboardMock().writeText).toHaveBeenCalledWith(
                "Copy this prompt",
            );
        });
        expect(
            screen.getByRole("button", { name: "Message copied" }),
        ).toBeInTheDocument();
    });

    it("renders image attachments below user text", () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
        const filePath = "/vault/assets/chat/screenshot.png";

        renderMessage({
            id: "user:with-image",
            role: "user",
            kind: "text",
            content: "Inspect this",
            timestamp: Date.now(),
            attachments: [
                {
                    id: "attachment:image",
                    type: "file",
                    noteId: null,
                    label: "Screenshot 10:32",
                    path: null,
                    filePath,
                    mimeType: "image/png",
                },
            ],
        });

        const image = screen.getByRole("img", { name: "Screenshot 10:32" });
        expect(image.getAttribute("src")).toContain(
            "neverwrite-file://localhost/vault/",
        );

        fireEvent.click(screen.getByRole("button", { name: "Open" }));
        fireEvent.click(
            screen.getByRole("button", { name: "Reveal in Finder" }),
        );

        expect(openPath).not.toHaveBeenCalledWith(filePath);
        expect(useEditorStore.getState().tabs).toEqual([
            expect.objectContaining({
                kind: "file",
                relativePath: "assets/chat/screenshot.png",
                title: "screenshot.png",
                path: filePath,
                mimeType: "image/png",
                viewer: "image",
                content: "",
            }),
        ]);
        expect(revealItemInDir).toHaveBeenCalledWith(filePath);
    });

    it("does not render attachment thumbnails when user text has no attachments", () => {
        renderMessage({
            id: "user:plain",
            role: "user",
            kind: "text",
            content: "No files here",
            timestamp: Date.now(),
        });

        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
    });

    it("does not render non-image attachments as thumbnails", () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        renderMessage({
            id: "user:with-file",
            role: "user",
            kind: "text",
            content: "Read this file",
            timestamp: Date.now(),
            attachments: [
                {
                    id: "attachment:file",
                    type: "file",
                    noteId: null,
                    label: "guide.md",
                    path: null,
                    filePath: "/vault/docs/guide.md",
                    mimeType: "text/markdown",
                },
            ],
        });

        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
    });

    it("shows a compact unavailable state for image paths outside the active vault", () => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });

        renderMessage({
            id: "user:external-image",
            role: "user",
            kind: "text",
            content: "Inspect this",
            timestamp: Date.now(),
            attachments: [
                {
                    id: "attachment:external-image",
                    type: "file",
                    noteId: null,
                    label: "external.png",
                    path: null,
                    filePath: "/outside/external.png",
                    mimeType: "image/png",
                },
            ],
        });

        expect(screen.getByText("Image unavailable")).toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
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

        const rail = expectChangeReviewRail("/vault/notes/watcher.md");
        expect(
            within(rail).getByRole("button", {
                name: "Open /vault/notes/watcher.md",
            }),
        ).toBeInTheDocument();
        expect(screen.queryByText("Reject")).not.toBeInTheDocument();

        expandChangeReviewRail("/vault/notes/watcher.md");
        fireEvent.click(
            screen.getByRole("button", { name: "Show source diff" }),
        );

        expect(screen.getByText(/old line/)).toBeInTheDocument();
        expect(screen.getByText(/new line/)).toBeInTheDocument();
    });

    it("opens the diff's own file when a tool reports multiple changes", () => {
        const firstPath = "/vault/notes/first.md";
        const secondPath = "/vault/notes/second.md";
        setVaultNotes([
            {
                id: "first-note",
                path: firstPath,
                title: "first",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "second-note",
                path: secondPath,
                title: "second",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        renderMessage({
            id: "tool:multi-file",
            role: "assistant",
            kind: "tool",
            title: "Apply updates",
            content: "Updated two notes",
            timestamp: Date.now(),
            diffs: [
                {
                    path: firstPath,
                    kind: "update",
                    old_text: "first old",
                    new_text: "first new",
                },
                {
                    path: secondPath,
                    kind: "update",
                    old_text: "second old",
                    new_text: "second new",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: firstPath,
            },
        });

        expect(
            within(getChangeReviewRail(firstPath)).getByRole("button", {
                name: `Open ${firstPath}`,
            }),
        ).toBeInTheDocument();
        expect(
            within(getChangeReviewRail(secondPath)).getByRole("button", {
                name: `Open ${secondPath}`,
            }),
        ).toBeInTheDocument();
    });

    it("disables line wrapping inside edit file diffs when editor line wrapping is disabled", () => {
        useSettingsStore.setState({ lineWrapping: false });
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
            id: "tool:no-wrap",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.md",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/notes/watcher.md",
                    kind: "update",
                    old_text: "const example = oldValue;",
                    new_text:
                        "const example = newVeryLongValueWithoutWrapping;",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/notes/watcher.md",
            },
        });

        expandChangeReviewRail("/vault/notes/watcher.md");
        fireEvent.click(
            screen.getByRole("button", { name: "Show source diff" }),
        );

        const diffPreview = screen.getByTestId(
            "diff-content:/vault/notes/watcher.md",
        );
        expect(diffPreview).toHaveAttribute("data-line-wrapping", "false");
        expect(diffPreview).toHaveStyle({
            overflowX: "auto",
        });
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

        expandChangeReviewRail("/vault/src/watcher.rs");

        expect(screen.getAllByText("13").length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText("+ old line")).not.toBeInTheDocument();
        expect(screen.queryByText("- new line")).not.toBeInTheDocument();
        expect(screen.queryByText("shared line")).not.toBeInTheDocument();
        expect(screen.getByText("old line")).toBeInTheDocument();
        expect(screen.getByText("new line")).toBeInTheDocument();
    });

    it("shows Open when the diff target is an openable text file", () => {
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

        const rail = expectChangeReviewRail("/vault/src/watcher.rs");
        expect(
            within(rail).getByRole("button", {
                name: "Open /vault/src/watcher.rs",
            }),
        ).toBeInTheDocument();
    });

    it("keeps historical work cycle diffs on the rich diff card", () => {
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

        expect(screen.queryByTestId("historical-diff-summary")).toBeNull();
        expect(screen.queryByText("Earlier change")).not.toBeInTheDocument();
        expect(screen.queryByTestId("recent-diff-badge")).toBeNull();
        expectChangeReviewRail("/vault/src/watcher.rs");
    });

    it("keeps non-visible work cycles on the rich diff card without a recency badge", () => {
        renderMessage(
            {
                id: "tool:recent",
                role: "assistant",
                kind: "tool",
                title: "Edit watcher",
                content: "Updated watcher.rs",
                timestamp: Date.now(),
                workCycleId: "cycle-recent",
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
            {
                visibleWorkCycleId: "cycle-current",
            },
        );

        expect(screen.queryByTestId("historical-diff-summary")).toBeNull();
        expect(screen.queryByTestId("recent-diff-badge")).toBeNull();
        expect(screen.queryByText("Recent change")).not.toBeInTheDocument();
        expectChangeReviewRail("/vault/src/watcher.rs");
    });

    it("keeps historical permission diffs inspectable without rendering decision actions", () => {
        renderMessage(
            {
                id: "permission:recent",
                role: "assistant",
                kind: "permission",
                title: "Permission request",
                content: "Edit watcher.rs",
                timestamp: Date.now(),
                workCycleId: "cycle-recent",
                permissionRequestId: "req-recent",
                permissionOptions: [
                    {
                        option_id: "allow_once",
                        name: "Allow once",
                        kind: "allow_once",
                    },
                    {
                        option_id: "reject_once",
                        name: "Reject",
                        kind: "reject_once",
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
                    status: "resolved",
                    resolved_option: "allow_once",
                    target: "/vault/src/watcher.rs",
                },
            },
            {
                visibleWorkCycleId: "cycle-current",
            },
        );

        expect(screen.queryByTestId("historical-diff-summary")).toBeNull();
        expect(screen.queryByTestId("recent-diff-badge")).toBeNull();
        expect(screen.getByText("Edited watcher.rs")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
        expect(
            screen.getByText("Decision sent: Allow once"),
        ).toBeInTheDocument();
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
            screen.queryByRole("button", { name: "Open" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("Edit 1 file")).not.toBeInTheDocument();
    });

    it("keeps review snapshots on the existing rich diff card", () => {
        renderMessage({
            id: "tool:review-snapshot",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.rs",
            timestamp: Date.now(),
            reviewDiffs: [
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

        const rail = expectChangeReviewRail("/vault/src/watcher.rs");
        expect(
            within(rail).getByRole("button", {
                name: "Open /vault/src/watcher.rs",
            }),
        ).toBeInTheDocument();
    });

    it("shows Writing for active edit cards without a target path", () => {
        renderMessage({
            id: "tool:writing",
            role: "assistant",
            kind: "tool",
            title: "Edit file",
            content: "Edit file",
            timestamp: Date.now(),
            meta: {
                tool: "edit",
                status: "in_progress",
            },
        });

        expect(screen.getByText("Writing")).toBeInTheDocument();
        expect(screen.queryByText("Edit file")).not.toBeInTheDocument();
    });

    it("falls back to the tool title after an untargeted edit finishes", () => {
        renderMessage({
            id: "tool:writing-complete",
            role: "assistant",
            kind: "tool",
            title: "Edit file",
            content: "Edit file",
            timestamp: Date.now(),
            meta: {
                tool: "edit",
                status: "completed",
            },
        });

        expect(screen.getByText("Edit file")).toBeInTheDocument();
        expect(screen.queryByText("Writing")).not.toBeInTheDocument();
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

        expect(screen.getByText("Edited watcher.rs")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Allow once" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Open" }),
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

        const rail = expectChangeReviewRail("/vault/archive/final.md");
        expect(within(rail).getByText("Moved from draft.md")).toBeInTheDocument();

        expandChangeReviewRail("/vault/archive/final.md");

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

        const rail = expectChangeReviewRail("/vault/archive/deleted.md");
        expect(within(rail).getByText("Partial")).toBeInTheDocument();

        expandChangeReviewRail("/vault/archive/deleted.md");

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

        expect(screen.getByText("+~1")).toBeInTheDocument();
        expect(screen.getByText("-~1")).toBeInTheDocument();

        expandChangeReviewRail("/vault/giant.md");
        fireEvent.click(
            screen.getByRole("button", { name: "Show source diff" }),
        );

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

        expandChangeReviewRail("/vault/src/watcher.rs");

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

    it("renders exact hunk diffs with a single line-number column in chat cards", () => {
        renderMessage({
            id: "tool:exact-hunks",
            role: "assistant",
            kind: "tool",
            title: "Edit file",
            content: "Updated exact.md",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/exact.md",
                    kind: "update",
                    old_text: "alpha\nbefore",
                    new_text: "alpha\nafter",
                    hunks: [
                        {
                            old_start: 101,
                            old_count: 2,
                            new_start: 101,
                            new_count: 2,
                            lines: [
                                { type: "context", text: "alpha" },
                                { type: "remove", text: "before" },
                                { type: "add", text: "after" },
                            ],
                        },
                    ],
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/exact.md",
            },
        });

        expandChangeReviewRail("/vault/exact.md");
        fireEvent.click(
            screen.getByRole("button", { name: "Show source diff" }),
        );

        expect(screen.queryByText("alpha")).not.toBeInTheDocument();
        expect(screen.queryByText("101")).not.toBeInTheDocument();
        expect(screen.getAllByText("102")).toHaveLength(2);
        expect(screen.getByText("before")).toBeInTheDocument();
        expect(screen.getByText("after")).toBeInTheDocument();
    });

    it("opens Markdown changes as a decorated preview and can return to the source diff", () => {
        renderMessage({
            id: "tool:markdown-preview",
            role: "assistant",
            kind: "tool",
            title: "Edit note",
            content: "Updated briefing.md",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/briefing.md",
                    kind: "update",
                    old_text: "> **Previous:** short note",
                    new_text: "> **Updated:** longer note",
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/briefing.md",
            },
        });

        expandChangeReviewRail("/vault/briefing.md");

        expect(screen.getByTestId("markdown-diff-preview")).toBeInTheDocument();
        expect(
            document.querySelectorAll('[data-markdown-preview-block="true"]'),
        ).toHaveLength(1);
        expect(screen.queryByText("Previous:")).toBeNull();
        expect(screen.getByText("Updated:")).toBeInTheDocument();
        expect(screen.queryByText("1")).toBeNull();

        fireEvent.click(
            screen.getByRole("button", { name: "Show source diff" }),
        );

        expect(screen.queryByTestId("markdown-diff-preview")).toBeNull();
        expect(
            screen.getByTestId("diff-content:/vault/briefing.md"),
        ).toBeInTheDocument();
    });

    it("renders a changed Markdown table in preview mode", () => {
        renderMessage({
            id: "tool:markdown-table-preview",
            role: "assistant",
            kind: "tool",
            title: "Edit table",
            content: "Updated status.md",
            timestamp: Date.now(),
            diffs: [
                {
                    path: "/vault/status.md",
                    kind: "update",
                    old_text: [
                        "| Status | Owner |",
                        "| --- | --- |",
                        "| Draft | Ana |",
                    ].join("\n"),
                    new_text: [
                        "| Status | Owner |",
                        "| --- | --- |",
                        "| Ready | Ana |",
                    ].join("\n"),
                },
            ],
            meta: {
                tool: "edit",
                status: "completed",
                target: "/vault/status.md",
            },
        });

        expandChangeReviewRail("/vault/status.md");

        expect(screen.getByRole("table")).toBeInTheDocument();
        expect(screen.getByRole("cell", { name: "Ready" })).toBeInTheDocument();
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
        expandChangeReviewRail("/vault/src/first.rs");
        expandChangeReviewRail("/vault/src/second.rs");

        expect(
            screen.getByTestId("diff-content:/vault/src/first.rs"),
        ).toHaveStyle({ fontSize: "0.76em" });
        expect(
            screen.getByTestId("diff-content:/vault/src/second.rs"),
        ).toHaveStyle({ fontSize: "0.76em" });
    });

    it("preserves expanded diff state when the row unmounts and remounts", () => {
        const message = createDiffMessage("tool:persisted-expand", {
            path: "/vault/src/persisted.rs",
            kind: "update",
            old_text: "old persisted",
            new_text: "new persisted",
        });

        const firstRender = renderMessage(message, {
            sessionId: "session-diff-state",
        });

        expandChangeReviewRail("/vault/src/persisted.rs");
        expect(
            screen.getByTestId("diff-content:/vault/src/persisted.rs"),
        ).toBeInTheDocument();

        firstRender.unmount();

        renderMessage(message, {
            sessionId: "session-diff-state",
        });

        expect(
            screen.getByTestId("diff-content:/vault/src/persisted.rs"),
        ).toBeInTheDocument();
    });
});

describe("AIChatMessageItem user mention pills", () => {
    it("uses the shared icon-led reference style for notes, files, and folders", () => {
        renderMessage({
            id: "user:references",
            role: "user",
            kind: "text",
            content:
                "Use [@Alpha], [@📄 /vault/src/watcher.rs], and [@📁 Clips]",
            timestamp: Date.now(),
        });

        const references = [
            screen.getByRole("button", { name: "Alpha" }),
            screen.getByRole("button", { name: "watcher.rs" }),
            document.querySelector<HTMLElement>('[title="Clips"]'),
        ];

        for (const reference of references) {
            expect(reference).not.toBeNull();
            expect(reference).toHaveStyle({
                background: "transparent",
                padding: "0px",
            });
            expect(reference?.querySelector("svg")).not.toBeNull();
        }
    });

    it("renders and opens sent line references with the shared style", async () => {
        setVaultNotes([
            {
                id: "CHANGELOG.md",
                title: "CHANGELOG",
                path: "/vault/CHANGELOG.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "changelog-tab",
                noteId: "CHANGELOG.md",
                title: "CHANGELOG",
                content: "# Changelog",
            },
        ]);
        renderMessage({
            id: "user:line-reference",
            role: "user",
            kind: "text",
            content: "Check [@📄 /vault/CHANGELOG.md#L66]",
            timestamp: Date.now(),
        });

        const reference = screen.getByRole("button", {
            name: "CHANGELOG.md (line 66)",
        });
        expect(reference).toHaveStyle({
            background: "transparent",
            padding: "0px",
        });
        expect(reference.querySelector("svg")).not.toBeNull();
        fireEvent.click(reference);

        await waitFor(() => {
            expect(useEditorStore.getState().pendingLineReveal).toEqual({
                noteId: "CHANGELOG.md",
                line: 66,
                endLine: null,
            });
        });
    });

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

    it("renders escaped note mentions with reserved characters", async () => {
        setVaultNotes([
            {
                id: "ideas/[ ] 2026 - Claude Opus 4.7 Lanzamiento.md",
                title: "[ ] 2026 - Claude Opus 4.7 Lanzamiento",
                path: "/vault/ideas/[ ] 2026 - Claude Opus 4.7 Lanzamiento.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "ideas/[ ] 2026 - Claude Opus 4.7 Lanzamiento.md",
                title: "[ ] 2026 - Claude Opus 4.7 Lanzamiento",
                content: "# Launch",
            },
        ]);

        renderMessage({
            id: "user:escaped-mention",
            role: "user",
            kind: "text",
            content:
                "Review [@|%5B%20%5D%202026%20-%20Claude%20Opus%204.7%20Lanzamiento]",
            timestamp: Date.now(),
        });

        fireEvent.contextMenu(
            screen.getByRole("button", {
                name: /\[ \] 2026 - Claude Op/,
            }),
            {
                clientX: 24,
                clientY: 36,
            },
        );
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });

    it("opens file mention pills in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/watcher.rs",
                });
                return {
                    path: "/vault/src/watcher.rs",
                    relative_path: "src/watcher.rs",
                    file_name: "watcher.rs",
                    mime_type: "text/rust",
                    content: "fn main() {}",
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "src/watcher.rs",
                path: "/vault/src/watcher.rs",
                relative_path: "src/watcher.rs",
                title: "watcher",
                file_name: "watcher.rs",
                extension: "rs",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 12,
                mime_type: "text/rust",
            },
        ]);

        renderMessage({
            id: "user:file-mention",
            role: "user",
            kind: "text",
            content: "Check [@📄 /vault/src/watcher.rs]",
            timestamp: Date.now(),
        });

        fireEvent.contextMenu(
            screen.getByRole("button", { name: "watcher.rs" }),
            {
                clientX: 24,
                clientY: 36,
            },
        );
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            path: "/vault/src/watcher.rs",
        });
    });
});

describe("AIChatMessageItem read tool targets", () => {
    it("opens child sessions from subagent breadcrumb tool actions", async () => {
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
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "child-session": {
                    sessionId: "child-session",
                    historySessionId: "child-session",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-session",
                    runtimeState: "live",
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["child-session"],
        }));

        renderMessage({
            id: "tool:subagent",
            role: "assistant",
            kind: "tool",
            title: "Spawned Worker",
            content: "Spawned Worker",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "child-session",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        fireEvent.click(screen.getByRole("button", { name: "Open Worker" }));

        await waitFor(() => {
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === "child-session",
                    ),
            ).toBe(true);
        });
    });

    it("labels subagent breadcrumbs from the resolved child session", () => {
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "child-session": {
                    sessionId: "child-session",
                    historySessionId: "child-session",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-session",
                    persistedTitle: "Franklin",
                    runtimeState: "live",
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["child-session"],
        }));

        renderMessage({
            id: "tool:subagent-name",
            role: "assistant",
            kind: "tool",
            title: "Started explorer",
            content: "Agent: /root/explorer",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "child-session",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        expect(
            screen.getByRole("button", { name: "Open Franklin" }),
        ).toBeEnabled();
        expect(
            screen.queryByRole("button", { name: "Open explorer" }),
        ).not.toBeInTheDocument();
    });

    it("updates a breadcrumb label when the child session arrives later", () => {
        renderMessage({
            id: "tool:subagent-late-name",
            role: "assistant",
            kind: "tool",
            title: "Started explorer",
            content: "Agent: /root/explorer",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "runtime-child",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        expect(
            screen.getByRole("button", { name: "Open explorer" }),
        ).toBeDisabled();

        act(() => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    "child-session": {
                        sessionId: "child-session",
                        historySessionId: "child-session",
                        runtimeSessionId: "runtime-child",
                        status: "idle",
                        runtimeId: "codex-acp",
                        modelId: "test-model",
                        modeId: "default",
                        models: [],
                        modes: [],
                        configOptions: [],
                        messages: [],
                        attachments: [],
                        parentSessionId: "parent-session",
                        persistedTitle: "Franklin",
                        runtimeState: "live",
                        activeWorkCycleId: null,
                        visibleWorkCycleId: null,
                        resumeContextPending: false,
                    },
                },
                sessionOrder: [...state.sessionOrder, "child-session"],
            }));
        });

        expect(
            screen.getByRole("button", { name: "Open Franklin" }),
        ).toBeEnabled();
    });

    it("opens restored subagent sessions by history id from persisted breadcrumbs", async () => {
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
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "persisted:child-history": {
                    sessionId: "persisted:child-history",
                    historySessionId: "child-history",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-history",
                    runtimeState: "persisted_only",
                    isPersistedSession: true,
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["persisted:child-history"],
        }));

        renderMessage({
            id: "tool:subagent-restored",
            role: "assistant",
            kind: "tool",
            title: "Spawned Worker",
            content: "Spawned Worker",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "child-history",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        fireEvent.click(screen.getByRole("button", { name: "Open Worker" }));

        await waitFor(() => {
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === "persisted:child-history",
                    ),
            ).toBe(true);
        });
    });

    it("prefers the live resumed subagent when a breadcrumb matches history id", async () => {
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
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "persisted:child-history": {
                    sessionId: "persisted:child-history",
                    historySessionId: "child-history",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-history",
                    runtimeState: "persisted_only",
                    isPersistedSession: true,
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
                "live-child": {
                    sessionId: "live-child",
                    historySessionId: "child-history",
                    runtimeSessionId: "runtime-child",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-history",
                    runtimeState: "live",
                    isPersistedSession: false,
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["persisted:child-history", "live-child"],
        }));

        renderMessage({
            id: "tool:subagent-resumed",
            role: "assistant",
            kind: "tool",
            title: "Spawned Worker",
            content: "Spawned Worker",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "child-history",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        fireEvent.click(screen.getByRole("button", { name: "Open Worker" }));

        await waitFor(() => {
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            tab.kind === "ai-chat" &&
                            tab.sessionId === "live-child",
                    ),
            ).toBe(true);
        });
    });

    it("shows unavailable subagent actions as non-interactive", () => {
        renderMessage({
            id: "tool:subagent-missing",
            role: "assistant",
            kind: "tool",
            title: "Spawned Worker",
            content: "Spawned Worker",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "missing-child-session",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        expect(screen.getByRole("button", { name: "Open Worker" })).toBeDisabled();
        expect(screen.getByTitle("Session is not available yet")).toBeInTheDocument();
    });

    it("derives rich subagent action labels from lifecycle titles", () => {
        renderMessage({
            id: "tool:subagent-responded",
            role: "assistant",
            kind: "tool",
            title: "Hypatia responded",
            content: "Hypatia responded",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "missing-child-session",
            },
            meta: {
                tool: "other",
                status: "completed",
            },
        });

        expect(
            screen.getByRole("button", { name: "Open Hypatia responded" }),
        ).toBeDisabled();
    });

    it("shows open session actions on subagent status breadcrumbs", () => {
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                "child-session": {
                    sessionId: "child-session",
                    historySessionId: "child-session",
                    status: "idle",
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                    parentSessionId: "parent-session",
                    runtimeState: "live",
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    resumeContextPending: false,
                },
            },
            sessionOrder: ["child-session"],
        }));

        renderMessage({
            id: "status:subagent-spawned",
            role: "system",
            kind: "status",
            title: "Spawned Mendel",
            content: "Status: pending",
            timestamp: Date.now(),
            toolAction: {
                kind: "open_session",
                session_id: "child-session",
            },
            meta: {
                status_event: "item_activity",
                status: "in_progress",
                emphasis: "neutral",
            },
        });

        expect(
            screen.getByRole("button", { name: "Open Mendel" }),
        ).toBeEnabled();
    });

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

    it("opens text file tool targets in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/watcher.rs",
                });
                return {
                    path: "/vault/src/watcher.rs",
                    relative_path: "src/watcher.rs",
                    file_name: "watcher.rs",
                    mime_type: "text/rust",
                    content: "fn main() {}",
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "src/watcher.rs",
                path: "/vault/src/watcher.rs",
                relative_path: "src/watcher.rs",
                title: "watcher.rs",
                file_name: "watcher.rs",
                extension: "rs",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 12,
                mime_type: "text/rust",
            },
        ]);

        renderMessage({
            id: "tool:read-rs",
            role: "assistant",
            kind: "tool",
            title: "Read file",
            content: "Read watcher.rs",
            timestamp: Date.now(),
            meta: {
                tool: "read",
                status: "completed",
                target: "/vault/src/watcher.rs",
            },
        });

        fireEvent.contextMenu(screen.getByText("watcher.rs"), {
            clientX: 32,
            clientY: 36,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            title: "watcher.rs",
            path: "/vault/src/watcher.rs",
        });
    });
});
