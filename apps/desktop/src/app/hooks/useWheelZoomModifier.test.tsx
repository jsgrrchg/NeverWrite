import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    isWheelZoomGesture,
    useWheelZoomModifier,
} from "./useWheelZoomModifier";
import { renderComponent } from "../../test/test-utils";

function WheelZoomProbe({
    onGesture,
}: {
    onGesture: (active: boolean) => void;
}) {
    const modifierRef = useWheelZoomModifier();

    return (
        <div
            data-testid="wheel-probe"
            onWheel={(event) =>
                onGesture(
                    isWheelZoomGesture(
                        event.nativeEvent as WheelEvent,
                        modifierRef,
                    ),
                )
            }
        />
    );
}

describe("useWheelZoomModifier", () => {
    it("keeps Command state available for wheel gestures", () => {
        const onGesture = vi.fn();

        renderComponent(<WheelZoomProbe onGesture={onGesture} />);

        fireEvent.keyDown(window, { key: "Meta" });
        fireEvent.wheel(screen.getByTestId("wheel-probe"), { deltaY: -10 });
        fireEvent.keyUp(window, { key: "Meta" });

        expect(onGesture).toHaveBeenCalledWith(true);
    });

    it("returns false when no zoom modifier is active", () => {
        const onGesture = vi.fn();

        renderComponent(<WheelZoomProbe onGesture={onGesture} />);

        fireEvent.wheel(screen.getByTestId("wheel-probe"), { deltaY: -10 });

        expect(onGesture).toHaveBeenCalledWith(false);
    });
});
