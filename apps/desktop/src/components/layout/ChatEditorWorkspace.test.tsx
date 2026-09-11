import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutState, readHydratedLayoutSnapshot, selectChatPaneSide, useLayoutStore } from "../../app/store/layoutStore";
import { ChatEditorWorkspace, getChatEditorWidths } from "./ChatEditorWorkspace";
import { safeStorageClear } from "../../app/utils/safeStorage";

vi.mock("../../features/ai/components/AIChatPane", () => ({ AIChatPane: () => <input aria-label="Draft" defaultValue="Keep me" /> }));
describe("dedicated chat layout", () => {
    beforeEach(() => { safeStorageClear(); useLayoutStore.setState(createDefaultLayoutState()); });
    it("follows Agents, permits an override and restores following", () => {
        const layout = useLayoutStore.getState();
        layout.moveSidebarView("agents", "right");
        expect(selectChatPaneSide(useLayoutStore.getState())).toBe("right");
        layout.setChatPanePlacement("left");
        expect(selectChatPaneSide(useLayoutStore.getState())).toBe("left");
        layout.setChatPanePlacement("follow-agents");
        expect(selectChatPaneSide(useLayoutStore.getState())).toBe("right");
        layout.setChatPaneWidth(700);
        expect(readHydratedLayoutSnapshot().chatPaneWidth).toBe(700);
    });
    it("keeps the composer mounted when moving, resizing and hiding", () => {
        render(<ChatEditorWorkspace><span>Editor contents</span></ChatEditorWorkspace>);
        const input = screen.getByRole("textbox", { name: "Draft" });
        fireEvent.change(input, { target: { value: "My draft" } });
        act(() => useLayoutStore.getState().setChatPanePlacement("right"));
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
        expect(useLayoutStore.getState().chatPaneWidth).toBe(500);
        act(() => useLayoutStore.getState().setChatPaneVisible(false));
        fireEvent.click(screen.getByRole("button", { name: "Chat" }));
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
        expect(input).toHaveValue("My draft");
    });
    it("clamps effective width while retaining the preferred width", () => {
        expect(getChatEditorWidths(800, 700)).toEqual({ narrow: false, chatWidth: 474 });
        expect(getChatEditorWidths(500, 700)).toEqual({ narrow: true, chatWidth: 500 });
        expect(useLayoutStore.getState().chatPaneWidth).toBe(480);
    });
});
