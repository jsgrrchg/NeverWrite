import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { getViewportSafeCenteredPosition } from "../../../app/utils/menuPosition";

export interface ChatPromptOutlineItem {
    id: string;
    label: string;
    ordinal: number;
}

interface ChatPromptOutlineMenuProps {
    anchorRef: RefObject<HTMLElement | null>;
    items: ChatPromptOutlineItem[];
    hasEarlierMessages: boolean;
    onSelect: (messageId: string) => void;
    onClose: () => void;
}

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 360;

export function ChatPromptOutlineMenu({
    anchorRef,
    items,
    hasEarlierMessages,
    onSelect,
    onClose,
}: ChatPromptOutlineMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: 8, y: 8 });

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        const menu = menuRef.current;
        if (!anchor || !menu) return;

        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const next = getViewportSafeCenteredPosition({
            centerX: anchorRect.left + anchorRect.width / 2,
            topY: anchorRect.top,
            bottomY: anchorRect.bottom,
            width: Math.max(menuRect.width, MENU_WIDTH),
            height: Math.min(menuRect.height, MENU_MAX_HEIGHT),
            gap: 6,
        });

        setPosition({ x: next.x, y: next.y });
    }, [anchorRef, items.length, hasEarlierMessages]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;

            if (menuRef.current?.contains(target)) return;
            if (anchorRef.current?.contains(target)) return;

            onClose();
        };

        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
        };

        const handleScroll = (event: Event) => {
            const target = event.target;
            if (target instanceof Node && menuRef.current?.contains(target)) {
                return;
            }
            onClose();
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("scroll", handleScroll, true);

        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [anchorRef, onClose]);

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            aria-label="User prompts"
            style={{
                position: "fixed",
                left: position.x,
                top: position.y,
                zIndex: 10000,
                width: MENU_WIDTH,
                maxHeight: MENU_MAX_HEIGHT,
                overflowY: "auto",
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {items.length === 0 ? (
                <div
                    className="px-3 py-2 text-xs"
                    role="status"
                    style={{ color: "var(--text-secondary)" }}
                >
                    No user prompts
                </div>
            ) : (
                items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        title={item.label}
                        aria-label={`Go to prompt ${item.ordinal}`}
                        className="w-full rounded px-2.5 py-1.5 text-left"
                        style={{
                            display: "grid",
                            gridTemplateColumns: "64px minmax(0, 1fr)",
                            alignItems: "baseline",
                            gap: 8,
                            border: "none",
                            background: "transparent",
                            color: "var(--text-primary)",
                            cursor: "pointer",
                        }}
                        onClick={() => onSelect(item.id)}
                        onMouseEnter={(event) => {
                            event.currentTarget.style.backgroundColor =
                                "var(--bg-tertiary)";
                        }}
                        onMouseLeave={(event) => {
                            event.currentTarget.style.backgroundColor =
                                "transparent";
                        }}
                    >
                        <span
                            className="text-[10px] tabular-nums"
                            style={{ color: "var(--text-secondary)" }}
                        >
                            Prompt {item.ordinal}
                        </span>
                        <span className="min-w-0 truncate text-xs">
                            {item.label}
                        </span>
                    </button>
                ))
            )}
            {hasEarlierMessages ? (
                <div
                    className="mt-1 border-t px-3 py-1.5 text-[11px]"
                    style={{
                        borderColor: "var(--border)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Earlier prompts are not loaded
                </div>
            ) : null}
        </div>,
        document.body,
    );
}
