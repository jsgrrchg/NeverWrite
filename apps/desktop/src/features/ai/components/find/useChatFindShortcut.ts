import { useEffect } from "react";
import type { RefObject } from "react";
import { matchesShortcutAction } from "../../../../app/shortcuts/registry";
import { getDesktopPlatform } from "../../../../app/utils/platform";

interface UseChatFindShortcutArgs {
    rootRef: RefObject<HTMLElement | null>;
    disabled?: boolean;
    onOpen: () => void;
}

const CHAT_FIND_INPUT_SELECTOR = '[role="search"] input';

/**
 * Opens the chat finder from Cmd/Ctrl+F while focus is inside a chat surface.
 * The listener is scoped to `rootRef`, so editor find bindings remain isolated.
 */
export function useChatFindShortcut({
    rootRef,
    disabled = false,
    onOpen,
}: UseChatFindShortcutArgs): void {
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const platform = getDesktopPlatform();
        const onKeyDown = (event: KeyboardEvent) => {
            if (!matchesShortcutAction(event, "find_in_note", platform)) return;
            if (disabled) return;
            event.preventDefault();
            event.stopPropagation();
            onOpen();
            requestAnimationFrame(() => {
                root.querySelector<HTMLInputElement>(
                    CHAT_FIND_INPUT_SELECTOR,
                )?.focus();
            });
        };
        root.addEventListener("keydown", onKeyDown);
        return () => root.removeEventListener("keydown", onKeyDown);
    }, [disabled, onOpen, rootRef]);
}
