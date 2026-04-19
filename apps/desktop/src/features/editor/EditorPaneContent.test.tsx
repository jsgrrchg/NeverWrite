import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderComponent, setEditorTabs } from "../../test/test-utils";
import { EditorPaneContent } from "./EditorPaneContent";

describe("EditorPaneContent", () => {
    it("renders the workspace chat history view for history tabs", () => {
        setEditorTabs([
            {
                id: "history-tab-1",
                kind: "ai-chat-history",
                title: "History",
            },
        ]);

        renderComponent(<EditorPaneContent />);

        expect(
            screen.getByTestId("ai-chat-history-workspace-view"),
        ).toBeInTheDocument();
        expect(screen.getByText("Chat History")).toBeInTheDocument();
    });
});
