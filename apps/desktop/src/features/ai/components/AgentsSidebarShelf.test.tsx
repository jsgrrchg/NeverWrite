import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import { AgentsSidebarShelf } from "./AgentsSidebarShelf";

function groups(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        root: { sessionId: `session-${index}` },
        sessionIds: [`session-${index}`],
    }));
}

describe("AgentsSidebarShelf", () => {
    it("keeps a focused row visible while collapsed", () => {
        renderComponent(
            <AgentsSidebarShelf
                title="Completed"
                groups={groups(7)}
                expanded={false}
                onExpandedChange={vi.fn()}
                focusedSessionId="session-6"
                initialLimit={5}
                renderGroup={(group) => <span>{group.root.sessionId}</span>}
            />,
        );
        expect(screen.getByText("session-6")).toBeInTheDocument();
        expect(screen.queryByText("session-0")).toBeNull();
    });

    it("pages without duplicating the focused exception", () => {
        renderComponent(
            <AgentsSidebarShelf
                title="Completed"
                groups={groups(7)}
                expanded
                onExpandedChange={vi.fn()}
                focusedSessionId="session-6"
                initialLimit={5}
                renderGroup={(group) => <span>{group.root.sessionId}</span>}
            />,
        );
        expect(screen.getAllByText("session-6")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
        expect(screen.getAllByText("session-6")).toHaveLength(1);
        expect(screen.getByText("session-5")).toBeInTheDocument();
    });
});
