import { fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { getDesktopPlatform } from "../../../../app/utils/platform";
import { renderComponent } from "../../../../test/test-utils";
import { useChatFindShortcut } from "./useChatFindShortcut";

function shortcutModifier() {
    return getDesktopPlatform() === "macos"
        ? { metaKey: true }
        : { ctrlKey: true };
}

function Harness({
    showRoot,
    onOpen,
}: {
    showRoot: boolean;
    onOpen: () => void;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    useChatFindShortcut({ rootRef, onOpen });

    if (!showRoot) {
        return <div>No chat selected</div>;
    }

    return (
        <div ref={rootRef}>
            <button type="button">Inside chat</button>
        </div>
    );
}

describe("useChatFindShortcut", () => {
    it("attaches after the root ref appears on a later render", () => {
        const onOpen = vi.fn();
        const view = renderComponent(
            <Harness showRoot={false} onOpen={onOpen} />,
        );

        view.rerender(<Harness showRoot onOpen={onOpen} />);
        const insideChat = screen.getByRole("button", {
            name: "Inside chat",
        });

        fireEvent.keyDown(insideChat, {
            key: "f",
            ...shortcutModifier(),
        });

        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});
