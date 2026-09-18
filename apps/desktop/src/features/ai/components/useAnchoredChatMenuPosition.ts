import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useState,
    type RefObject,
} from "react";
import { getViewportSafeMenuPosition } from "../../../app/utils/menuPosition";

const VIEWPORT_PADDING = 8;
const MENU_GAP = 4;

interface AnchoredChatMenuPosition {
    left: number;
    top: number;
}

/**
 * Positions a portalled chat menu next to its composer control. Chat controls
 * live inside an existing backdrop-filter surface, so their frosted menus must
 * be portalled out of that backdrop root for Chromium to render another blur.
 */
export function useAnchoredChatMenuPosition(
    anchorRef: RefObject<HTMLElement | null>,
    menuRef: RefObject<HTMLElement | null>,
    open: boolean,
): AnchoredChatMenuPosition | null {
    const [position, setPosition] = useState<AnchoredChatMenuPosition | null>(
        null,
    );

    const updatePosition = useCallback(() => {
        const anchorElement = anchorRef.current;
        const menuElement = menuRef.current;
        if (!anchorElement || !menuElement) return;

        const anchorRect = anchorElement.getBoundingClientRect();
        const menuRect = menuElement.getBoundingClientRect();
        const width = Math.ceil(menuRect.width);
        const height = Math.ceil(menuRect.height);
        const availableAbove = anchorRect.top - MENU_GAP - VIEWPORT_PADDING;
        const availableBelow =
            window.innerHeight -
            anchorRect.bottom -
            MENU_GAP -
            VIEWPORT_PADDING;
        const openAbove =
            availableAbove >= height || availableAbove >= availableBelow;
        const desiredTop = openAbove
            ? anchorRect.top - height - MENU_GAP
            : anchorRect.bottom + MENU_GAP;
        const safe = getViewportSafeMenuPosition(
            anchorRect.left,
            desiredTop,
            width,
            height,
            VIEWPORT_PADDING,
        );

        setPosition({ left: safe.x, top: safe.y });
    }, [anchorRef, menuRef]);

    useLayoutEffect(() => {
        if (!open) {
            setPosition(null);
            return;
        }
        updatePosition();
    }, [open, updatePosition]);

    useEffect(() => {
        if (!open) return;

        const handleViewportChange = () => updatePosition();
        const observer = new ResizeObserver(handleViewportChange);
        if (menuRef.current) observer.observe(menuRef.current);
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", handleViewportChange);
            window.removeEventListener("scroll", handleViewportChange, true);
        };
    }, [menuRef, open, updatePosition]);

    return position;
}
