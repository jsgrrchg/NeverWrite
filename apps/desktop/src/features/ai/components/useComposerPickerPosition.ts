import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
    CHAT_COMPOSER_PICKER_MAX_HEIGHT,
    getComposerAnchoredPickerWidth,
    getViewportSafeMenuPosition,
} from "../../../app/utils/menuPosition";

const VIEWPORT_PADDING = 8;
const COMPOSER_PICKER_GAP = 8;

interface ComposerPickerPosition {
    maxHeight: number;
    width: number;
    x: number;
    y: number;
}

/**
 * Positions an inline picker as a full-width extension of the chat composer.
 * Keeping this shared prevents the @ and / menus from drifting apart.
 */
export function useComposerPickerPosition(
    anchorElement: HTMLElement | null,
    pickerElement: HTMLElement | null,
    open: boolean,
    itemCount: number,
): ComposerPickerPosition | null {
    const [position, setPosition] = useState<ComposerPickerPosition | null>(
        null,
    );

    const updatePosition = useCallback(() => {
        if (!anchorElement) return;

        const anchorRect = anchorElement.getBoundingClientRect();
        const width = getComposerAnchoredPickerWidth(
            anchorRect.width,
            window.innerWidth,
        );
        const estimatedHeight = Math.min(
            CHAT_COMPOSER_PICKER_MAX_HEIGHT,
            itemCount * 32 + 8,
        );
        const measuredHeight = Math.ceil(
            pickerElement?.getBoundingClientRect().height ?? estimatedHeight,
        );
        const availableAbove = Math.max(
            0,
            anchorRect.top - COMPOSER_PICKER_GAP - VIEWPORT_PADDING,
        );
        const availableBelow = Math.max(
            0,
            window.innerHeight -
                anchorRect.bottom -
                COMPOSER_PICKER_GAP -
                VIEWPORT_PADDING,
        );
        const openAbove =
            availableAbove >= measuredHeight || availableAbove >= availableBelow;
        // JSDOM and a just-mounted detached pane can briefly report no usable
        // viewport geometry. Keep the picker visible until the next layout pass.
        const maxHeight =
            availableAbove === 0 && availableBelow === 0
                ? CHAT_COMPOSER_PICKER_MAX_HEIGHT
                : Math.min(
                      CHAT_COMPOSER_PICKER_MAX_HEIGHT,
                      openAbove ? availableAbove : availableBelow,
                  );
        const height = Math.min(maxHeight, measuredHeight);
        const safeX = getViewportSafeMenuPosition(
            anchorRect.left,
            VIEWPORT_PADDING,
            width,
            0,
            VIEWPORT_PADDING,
        ).x;

        setPosition({
            maxHeight,
            width,
            x: safeX,
            y: openAbove
                ? Math.max(VIEWPORT_PADDING, anchorRect.top - height - COMPOSER_PICKER_GAP)
                : Math.min(
                      window.innerHeight - height - VIEWPORT_PADDING,
                      anchorRect.bottom + COMPOSER_PICKER_GAP,
                  ),
        });
    }, [anchorElement, itemCount, pickerElement]);

    useLayoutEffect(() => {
        if (!open) return;
        updatePosition();
    }, [open, updatePosition]);

    useEffect(() => {
        if (!open) return;

        const handleViewportChange = () => updatePosition();
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
        return () => {
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
        };
    }, [open, updatePosition]);

    return position;
}
