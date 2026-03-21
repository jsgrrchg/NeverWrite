import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChangeRail } from "./ChangeRail";
import type { ChangeRailMarker } from "./changePresentationModel";

function makeMarker(
    key: string,
    overrides: Partial<ChangeRailMarker> = {},
): ChangeRailMarker {
    return {
        key,
        editIndex: 0,
        newStart: 0,
        newEnd: 1,
        oldStart: 0,
        oldEnd: 1,
        kind: "modify",
        reviewState: "finalized",
        topRatio: 0,
        heightRatio: 0.2,
        ...overrides,
    };
}

describe("ChangeRail", () => {
    it("renders markers and navigation controls", () => {
        render(
            <div style={{ height: 240 }}>
                <ChangeRail
                    markers={[makeMarker("first"), makeMarker("second")]}
                    activeMarkerKey="first"
                    hoveredMarkerKey={null}
                    onMarkerHover={() => {}}
                    onMarkerClick={() => {}}
                    onPreviousChange={() => {}}
                    onNextChange={() => {}}
                />
            </div>,
        );

        expect(screen.getByLabelText("Change rail")).toBeInTheDocument();
        expect(screen.getByLabelText("Previous change")).toBeInTheDocument();
        expect(screen.getByLabelText("Next change")).toBeInTheDocument();
        expect(screen.getAllByLabelText(/Change \d+/)).toHaveLength(2);
    });

    it("calls hover and click callbacks for markers", () => {
        const onMarkerHover = vi.fn();
        const onMarkerClick = vi.fn();

        render(
            <div style={{ height: 240 }}>
                <ChangeRail
                    markers={[makeMarker("first")]}
                    activeMarkerKey={null}
                    hoveredMarkerKey={null}
                    onMarkerHover={onMarkerHover}
                    onMarkerClick={onMarkerClick}
                />
            </div>,
        );

        const marker = screen.getByLabelText("Change 1");
        fireEvent.mouseEnter(marker);
        fireEvent.click(marker);
        fireEvent.mouseLeave(marker);

        expect(onMarkerHover).toHaveBeenNthCalledWith(1, "first");
        expect(onMarkerHover).toHaveBeenLastCalledWith(null);
        expect(onMarkerClick).toHaveBeenCalledWith("first");
    });

    it("marks the active rail marker", () => {
        render(
            <div style={{ height: 240 }}>
                <ChangeRail
                    markers={[makeMarker("first"), makeMarker("second")]}
                    activeMarkerKey="second"
                    hoveredMarkerKey={null}
                    onMarkerHover={() => {}}
                    onMarkerClick={() => {}}
                />
            </div>,
        );

        expect(screen.getByLabelText("Change 2")).toHaveAttribute(
            "aria-current",
            "true",
        );
        expect(screen.getByLabelText("Change 1")).not.toHaveAttribute(
            "aria-current",
        );
    });
});
