import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";

const entries: ContextMenuEntry[] = [
    { label: "Copy", action: vi.fn() },
    { label: "Paste", action: vi.fn() },
];

function renderMenu(onClose = vi.fn()) {
    return {
        onClose,
        ...render(
            <ContextMenu
                menu={{ x: 100, y: 100, payload: undefined }}
                entries={entries}
                onClose={onClose}
            />,
        ),
    };
}

describe("ContextMenu scroll-to-close behaviour", () => {
    it("closes when a scrollable ancestor of the anchor scrolls", () => {
        const onClose = vi.fn();

        // Create a container that geometrically contains the menu anchor (100, 100)
        const ancestor = document.createElement("div");
        Object.defineProperty(ancestor, "getBoundingClientRect", {
            value: () => ({
                left: 0,
                top: 0,
                right: 500,
                bottom: 500,
                width: 500,
                height: 500,
            }),
        });
        document.body.appendChild(ancestor);

        renderMenu(onClose);

        // Scroll event from the ancestor (contains the anchor point)
        const scrollEvent = new Event("scroll", { bubbles: false });
        Object.defineProperty(scrollEvent, "target", { value: ancestor });
        window.dispatchEvent(scrollEvent);

        expect(onClose).toHaveBeenCalled();

        document.body.removeChild(ancestor);
    });

    it("does NOT close when an unrelated panel scrolls (e.g. AI chat during streaming)", () => {
        const onClose = vi.fn();

        // Create a container that does NOT contain the anchor point (100, 100)
        const chatPanel = document.createElement("div");
        Object.defineProperty(chatPanel, "getBoundingClientRect", {
            value: () => ({
                left: 800,
                top: 0,
                right: 1200,
                bottom: 600,
                width: 400,
                height: 600,
            }),
        });
        document.body.appendChild(chatPanel);

        renderMenu(onClose);

        // Scroll event from the chat panel (does NOT contain the anchor)
        const scrollEvent = new Event("scroll", { bubbles: false });
        Object.defineProperty(scrollEvent, "target", { value: chatPanel });
        window.dispatchEvent(scrollEvent);

        expect(onClose).not.toHaveBeenCalled();

        document.body.removeChild(chatPanel);
    });

    it("closes when the document itself scrolls", () => {
        const onClose = vi.fn();
        renderMenu(onClose);

        const scrollEvent = new Event("scroll", { bubbles: false });
        Object.defineProperty(scrollEvent, "target", { value: document });
        window.dispatchEvent(scrollEvent);

        expect(onClose).toHaveBeenCalled();
    });

    it("closes on Escape key", () => {
        const onClose = vi.fn();
        renderMenu(onClose);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });

    it("closes on mousedown outside the menu", () => {
        const onClose = vi.fn();
        renderMenu(onClose);
        fireEvent.mouseDown(document.body);
        expect(onClose).toHaveBeenCalled();
    });
});
