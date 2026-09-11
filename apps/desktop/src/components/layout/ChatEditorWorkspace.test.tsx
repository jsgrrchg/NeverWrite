import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChatEditorWidths, createDefaultLayoutState, readHydratedLayoutSnapshot, selectChatPaneSide, useLayoutStore } from "../../app/store/layoutStore";
import { useEditorStore } from "../../app/store/editorStore";
import { useChatTabsStore } from "../../features/ai/store/chatTabsStore";
import { ChatEditorWorkspace } from "./ChatEditorWorkspace";
import { safeStorageClear } from "../../app/utils/safeStorage";

vi.mock("../../features/ai/components/AIChatPane", () => ({ AIChatPane: () => <input aria-label="Draft" defaultValue="Keep me" /> }));
const measuredWidth = vi.hoisted(() => ({ value: 1200 }));
vi.mock("./useElementWidth", () => ({ useElementWidth: () => ({ ref: { current: null }, width: measuredWidth.value }) }));
describe("dedicated chat layout", () => {
    beforeEach(() => {
        measuredWidth.value = 1200;
        safeStorageClear();
        useLayoutStore.setState(createDefaultLayoutState());
        useChatTabsStore.getState().reset();
        useEditorStore.getState().hydrateTabs([], null);
    });
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
        useEditorStore.getState().openNote("note-1", "Note", "# Note");
        render(<ChatEditorWorkspace><span>Editor contents</span></ChatEditorWorkspace>);
        const input = screen.getByRole("textbox", { name: "Draft" });
        fireEvent.change(input, { target: { value: "My draft" } });
        act(() => useLayoutStore.getState().setChatPanePlacement("right"));
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
        expect(useLayoutStore.getState().chatPaneWidth).toBe(500);
        act(() => useLayoutStore.getState().setChatPaneVisible(false));
        expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Editor" })).toBeNull();
        act(() => useLayoutStore.getState().setChatPaneVisible(true));
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
        expect(input).toHaveValue("My draft");
    });
    it("clamps effective width while retaining the preferred width", () => {
        expect(getChatEditorWidths(800, 700)).toEqual({ narrow: false, chatWidth: 479 });
        expect(getChatEditorWidths(500, 700)).toEqual({ narrow: true, chatWidth: 249.5 });
        expect(useLayoutStore.getState().chatPaneWidth).toBe(480);
    });
    it("keeps both panes visible in a narrow workspace when focus changes", () => {
        measuredWidth.value = 500;
        useEditorStore.getState().openNote("note-1", "Note", "# Note");
        render(<ChatEditorWorkspace><span>Editor contents</span></ChatEditorWorkspace>);
        const chat = screen.getByTestId("dedicated-chat-surface");
        const editor = screen.getByTestId("document-workspace-surface");
        expect(chat).toHaveStyle({ width: "249.5px" });
        for (const surface of ["chat", "editor"] as const) {
            act(() => useChatTabsStore.getState().setFocusedSurface(surface));
            expect(chat).toBeVisible();
            expect(editor).toBeVisible();
            expect(screen.getByRole("separator")).toBeVisible();
        }
    });
    it("uses the full workspace for chat until an editor tab opens", () => {
        render(<ChatEditorWorkspace><span>Editor contents</span></ChatEditorWorkspace>);

        const chat = screen.getByTestId("dedicated-chat-surface");
        const editor = screen.getByTestId("document-workspace-surface");
        const separator = screen.getByRole("separator", { hidden: true });

        expect(chat).toHaveStyle({ width: "100%" });
        expect(editor).toHaveStyle({ display: "none" });
        expect(separator).not.toBeVisible();

        act(() => {
            useEditorStore.getState().openNote("note-1", "Note", "# Note");
        });

        expect(chat).toHaveStyle({ width: "480px" });
        expect(editor.style.display).toBe("");
        expect(separator).toBeVisible();

        act(() => {
            useEditorStore
                .getState()
                .closeTab(useEditorStore.getState().activeTabId!);
        });

        expect(chat).toHaveStyle({ width: "100%" });
        expect(editor).toHaveStyle({ display: "none" });
        expect(separator).not.toBeVisible();
    });
});
