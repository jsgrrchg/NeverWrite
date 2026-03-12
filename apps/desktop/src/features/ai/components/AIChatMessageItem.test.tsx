import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatMessage } from "../types";
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

function renderMessage(message: AIChatMessage) {
    return renderComponent(
        <AIChatMessageItem message={message} pillMetrics={pillMetrics} />,
    );
}

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
        renderMessage({
            id: "tool:1",
            role: "assistant",
            kind: "tool",
            title: "Edit watcher",
            content: "Updated watcher.rs",
            timestamp: Date.now(),
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
        expect(screen.getByRole("button", { name: "Open File" })).toBeInTheDocument();
        expect(screen.queryByText("Reject")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /watcher.rs/i }));

        expect(screen.getByText(/old line/)).toBeInTheDocument();
        expect(screen.getByText(/new line/)).toBeInTheDocument();
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
        expect(screen.queryByRole("button", { name: "Open File" })).not.toBeInTheDocument();
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
        expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open File" })).not.toBeInTheDocument();
    });
});
