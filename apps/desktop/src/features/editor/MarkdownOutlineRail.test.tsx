import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { extractHeadings } from "../notes/outlineModel";
import { createEditorOutlineBridge, type EditorOutlineSnapshot } from "./extensions/editorOutline";
import { MarkdownOutlineRail } from "./MarkdownOutlineRail";
import { resolveOutlineRailLayout } from "./markdownOutlineRailLayout";

const snapshot: EditorOutlineSnapshot = {
    headings: extractHeadings("# Root\n## Child\n### Leaf"),
    activeId: null, width: 600, height: 400, gutter: 56, rightInset: 10,
};

describe("MarkdownOutlineRail", () => {
    it("previews heading hierarchy, marks the active section, and navigates", () => {
        const bridge = createEditorOutlineBridge();
        bridge.getSnapshot = () => ({ ...snapshot, activeId: snapshot.headings[1].id });
        // useSyncExternalStore requires a cached snapshot.
        const current = bridge.getSnapshot();
        bridge.getSnapshot = () => current;
        bridge.select = vi.fn();
        renderComponent(<MarkdownOutlineRail bridge={bridge} />);
        const rail = screen.getByTestId("markdown-outline-rail");
        expect(rail).toHaveAttribute("data-side", "right");
        expect(rail.querySelectorAll('[data-in-view="true"]')).toHaveLength(1);
        const button = screen.getByRole("button", { name: "Jump to heading" });
        fireEvent.focus(button);
        fireEvent.keyDown(button, { key: "End" });
        expect(screen.getByText("Root › Child · H3")).toBeInTheDocument();
        expect(button).toHaveAccessibleName("Jump to heading: Leaf (H3)");
        fireEvent.keyDown(button, { key: "Enter" });
        expect(bridge.select).toHaveBeenCalledWith(snapshot.headings[2]);
    });

    it("uses panel height and hides when a safe gutter is unavailable", () => {
        expect(resolveOutlineRailLayout(snapshot, 100)?.height).toBe(304);
        expect(resolveOutlineRailLayout(snapshot, 1)).toBeNull();
        expect(resolveOutlineRailLayout({ ...snapshot, gutter: 24 }, 3)).toBeNull();
        expect(resolveOutlineRailLayout({ ...snapshot, height: 100 }, 3)).toBeNull();
        expect(resolveOutlineRailLayout({ ...snapshot, width: 200 }, 3)).toBeNull();
        const small = resolveOutlineRailLayout({ ...snapshot, width: 280, height: 160 }, 100)!;
        expect(small.height).toBe(64);
        expect(small.previewWidth + 44 + snapshot.rightInset).toBeLessThan(280);
    });
});
