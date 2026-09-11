import { fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import * as platform from "../../../../app/utils/platform";
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
    it.each(["macos", "windows", "linux"] as const)(
        "opens only from inside chat with the %s modifier",
        (desktopPlatform) => {
            const platformSpy = vi.spyOn(platform, "getDesktopPlatform").mockReturnValue(desktopPlatform);
            try {
                const onOpen = vi.fn();
                renderComponent(<Harness showRoot onOpen={onOpen} />);
                const inside = screen.getByRole("button", { name: "Inside chat" });
                const modifiers = desktopPlatform === "macos" ? { metaKey: true } : { ctrlKey: true };
                fireEvent.keyDown(document.body, { key: "f", ...modifiers });
                expect(onOpen).not.toHaveBeenCalled();
                inside.focus();
                fireEvent.keyDown(inside, { key: "f" });
                expect(onOpen).not.toHaveBeenCalled();
                fireEvent.keyDown(inside, { key: "f", ...modifiers });
                expect(onOpen).toHaveBeenCalledTimes(1);
            } finally {
                platformSpy.mockRestore();
            }
        },
    );

});
