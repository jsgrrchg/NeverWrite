import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../test/test-utils";
import { NavigationRail } from "./NavigationRail";

const items = [{ id: "first" }, { id: "last" }];

describe("NavigationRail", () => {
    it("mirrors the rail and preview and selects the pointer destination", () => {
        const onSelect = vi.fn();
        renderComponent(
            <NavigationRail
                side="right"
                items={items}
                height={80}
                hitStripWidth={32}
                hasPersistentGutter
                testId="rail"
                getLabel={(item) => `Jump: ${item?.id ?? "heading"}`}
                renderPreview={(item) => <span>{item.id}</span>}
                onSelect={onSelect}
            />,
        );
        const button = screen.getByRole("button");
        vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ top: 100, height: 80 } as DOMRect);
        expect(screen.getByTestId("rail")).toHaveStyle({ right: "0px" });
        fireEvent.mouseMove(button, { clientY: 180 });
        expect(screen.getByText("last").closest("[data-navigation-rail-preview]")).toHaveStyle({ right: "32px" });
        fireEvent.click(screen.getByText("last"));
        expect(onSelect).not.toHaveBeenCalled();
        fireEvent.click(button, { detail: 1, clientY: 180 });
        expect(onSelect).toHaveBeenCalledWith(items[1]);
    });

    it("supports keyboard activation and excludes an unusable gutter from tab order", () => {
        const onSelect = vi.fn();
        const props = {
            items, height: 80, hitStripWidth: 32, hasPersistentGutter: true,
            testId: "rail", getLabel: () => "Jump", renderPreview: (item: { id: string }) => item.id,
            onSelect,
        };
        const view = renderComponent(<NavigationRail {...props} />);
        const button = screen.getByRole("button");
        fireEvent.focus(button);
        fireEvent.keyDown(button, { key: "End" });
        fireEvent.keyDown(button, { key: "Enter" });
        expect(onSelect).toHaveBeenCalledWith(items[1]);
        fireEvent.keyDown(button, { key: "Escape" });
        expect(screen.queryByText("last")).not.toBeInTheDocument();
        view.rerender(<NavigationRail {...props} hitStripWidth={0} />);
        expect(button).toHaveAttribute("tabindex", "-1");
    });
});
