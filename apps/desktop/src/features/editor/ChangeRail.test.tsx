import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChangeRailMarker } from "./changePresentationModel";
import { ChangeRail } from "./ChangeRail";

function makeMarker(
    key: string,
    kind: ChangeRailMarker["kind"],
    editIndex: number,
): ChangeRailMarker {
    return {
        key,
        startLine: editIndex * 3,
        endLine: editIndex * 3 + (kind === "delete" ? 0 : 1),
        anchorLine: editIndex * 3,
        kind,
        reviewState: "finalized",
        topRatio: editIndex * 0.25,
        heightRatio: 0.2,
    };
}

describe("ChangeRail", () => {
    it("renders navigation and marker controls for the current snapshot", () => {
        const onMarkerHover = vi.fn();
        const onMarkerClick = vi.fn();
        const onPreviousChange = vi.fn();
        const onNextChange = vi.fn();

        render(
            <ChangeRail
                markers={[
                    makeMarker("edit-0", "add", 0),
                    makeMarker("edit-1", "modify", 1),
                ]}
                activeMarkerKey="edit-1"
                hoveredMarkerKey="edit-0"
                onMarkerHover={onMarkerHover}
                onMarkerClick={onMarkerClick}
                onPreviousChange={onPreviousChange}
                onNextChange={onNextChange}
            />,
        );

        expect(screen.getByLabelText("Change rail")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Previous change" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next change" })).toBeInTheDocument();

        const activeMarker = screen.getByRole("button", { name: "Change 2" });
        expect(activeMarker).toHaveAttribute("aria-current", "true");

        fireEvent.mouseEnter(screen.getByRole("button", { name: "Change 1" }));
        expect(onMarkerHover).toHaveBeenCalledWith("edit-0");

        fireEvent.click(activeMarker);
        expect(onMarkerClick).toHaveBeenCalledWith("edit-1");

        fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
        fireEvent.click(screen.getByRole("button", { name: "Next change" }));
        expect(onPreviousChange).toHaveBeenCalledTimes(1);
        expect(onNextChange).toHaveBeenCalledTimes(1);
    });

    it("returns null when hidden or empty", () => {
        const { container, rerender } = render(
            <ChangeRail
                markers={[]}
                activeMarkerKey={null}
                hoveredMarkerKey={null}
                onMarkerHover={() => undefined}
                onMarkerClick={() => undefined}
            />,
        );

        expect(container).toBeEmptyDOMElement();

        rerender(
            <ChangeRail
                hidden
                markers={[makeMarker("edit-0", "add", 0)]}
                activeMarkerKey={null}
                hoveredMarkerKey={null}
                onMarkerHover={() => undefined}
                onMarkerClick={() => undefined}
            />,
        );

        expect(container).toBeEmptyDOMElement();
    });
});
