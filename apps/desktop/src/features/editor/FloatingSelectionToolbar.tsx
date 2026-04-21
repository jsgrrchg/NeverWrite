import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getViewportSafeCenteredPosition } from "../../app/utils/menuPosition";
import { formatShortcutAction } from "../../app/shortcuts/format";
import { getDesktopPlatform } from "../../app/utils/platform";
import type { SelectionToolbarAction } from "./selectionTransforms";

export type FloatingSelectionToolbarState = {
    x: number;
    top: number;
    bottom: number;
    selectionFrom: number;
    selectionTo: number;
};

type ToolbarButton = {
    action: SelectionToolbarAction;
    label: ReactNode;
    title: string;
    prominent?: boolean;
    compact?: boolean;
};

function ToolbarIcon({ d, fill }: { d: string; fill?: boolean }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
        >
            <path
                d={d}
                {...(fill
                    ? { fill: "currentColor" }
                    : {
                          stroke: "currentColor",
                          strokeWidth: "1.5",
                          strokeLinecap: "round" as const,
                          strokeLinejoin: "round" as const,
                      })}
            />
        </svg>
    );
}

function HighlightIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="m9.9 3.2 2.9 2.9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="m5.1 10.9 5.8-5.8 1.8 1.8-5.8 5.8H5.1v-1.8Z"
                fill="currentColor"
                opacity="0.92"
            />
            <path
                d="M4.3 12.9h7.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                opacity="0.55"
            />
        </svg>
    );
}

const TOOLBAR_BUTTONS: ToolbarButton[] = [
    // Inline formatting
    {
        action: "bold",
        label: "B",
        title: "Bold",
        prominent: true,
        compact: true,
    },
    { action: "italic", label: "I", title: "Italic", compact: true },
    {
        action: "highlight",
        label: <HighlightIcon />,
        title: "Highlight",
        compact: true,
    },
    { action: "code", label: "</>", title: "Code", compact: true },
    // Links
    {
        action: "link",
        label: (
            <ToolbarIcon d="M7 9a3 3 0 0 0 4.24.01l2.12-2.12a3 3 0 0 0-4.24-4.24L7.76 4M9 7a3 3 0 0 0-4.24-.01L2.64 9.11a3 3 0 0 0 4.24 4.24L8.24 12" />
        ),
        title: "Link",
        compact: true,
    },
    {
        action: "wikilink",
        label: <ToolbarIcon d="M6 3v10M10 3v10M3 6h10M3 10h10" />,
        title: "Wikilink",
        compact: true,
    },
    // Block elements
    {
        action: "quote",
        label: <ToolbarIcon d="M5 4v8M9 4l4 4-4 4" />,
        title: "Quote",
        compact: true,
    },
    {
        action: "task",
        label: <ToolbarIcon d="M3 3h10v10H3zM6 7.5l1.5 1.5L10 6" />,
        title: "Task",
        compact: true,
    },
    // Headings
    { action: "heading-1", label: "H1", title: "Heading 1", compact: true },
    { action: "heading-2", label: "H2", title: "Heading 2", compact: true },
    { action: "heading-3", label: "H3", title: "Heading 3", compact: true },
    {
        action: "heading-0",
        label: "Tx",
        title: "Remove Heading",
        compact: true,
    },
];

export function FloatingSelectionToolbar({
    toolbar,
    editorElement,
    onAction,
    onAddToChat,
    onClose,
}: {
    toolbar: FloatingSelectionToolbarState;
    editorElement: HTMLElement | null;
    onAction: (action: SelectionToolbarAction) => void;
    onAddToChat?: () => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const addToChatShortcut = formatShortcutAction(
        "add_selection_to_chat",
        getDesktopPlatform(),
    );
    const [position, setPosition] = useState<{
        x: number;
        y: number;
        placement: "top" | "bottom";
    }>({
        x: toolbar.x,
        y: toolbar.top,
        placement: "top",
    });

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;

        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeCenteredPosition({
                centerX: toolbar.x,
                topY: toolbar.top,
                bottomY: toolbar.bottom,
                width: rect.width,
                height: rect.height,
                gap: 10,
            }),
        );
    }, [toolbar.bottom, toolbar.top, toolbar.x]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (ref.current?.contains(target)) return;
            if (editorElement?.contains(target)) return;
            onClose();
        };

        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);

        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [editorElement, onClose]);

    return createPortal(
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10020,
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: 4,
                borderRadius: 999,
                border: "1px solid color-mix(in srgb, var(--border) 88%, transparent)",
                background:
                    "color-mix(in srgb, var(--bg-elevated) 94%, transparent)",
                boxShadow: "0 8px 18px rgba(15, 23, 42, 0.1)",
                backdropFilter: "blur(10px)",
            }}
            data-placement={position.placement}
        >
            {TOOLBAR_BUTTONS.map((button) => (
                <button
                    key={button.action}
                    type="button"
                    title={button.title}
                    aria-label={button.title}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        onAction(button.action);
                    }}
                    style={{
                        border: "none",
                        borderRadius: 999,
                        background: "transparent",
                        color: "var(--text-primary)",
                        minWidth: button.compact ? 26 : 36,
                        height: 26,
                        padding: button.compact ? "0 7px" : "0 8px",
                        fontSize: 11,
                        fontStyle:
                            button.action === "italic" ? "italic" : "normal",
                        fontWeight: button.prominent ? 700 : 560,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        letterSpacing: button.compact ? 0 : "-0.01em",
                    }}
                    onMouseEnter={(event) => {
                        event.currentTarget.style.background =
                            "var(--bg-tertiary)";
                    }}
                    onMouseLeave={(event) => {
                        event.currentTarget.style.background = "transparent";
                    }}
                >
                    {button.label}
                </button>
            ))}
            {onAddToChat && (
                <>
                    <div
                        style={{
                            width: 1,
                            height: 16,
                            background: "var(--border)",
                            opacity: 0.5,
                            flexShrink: 0,
                        }}
                    />
                    <button
                        type="button"
                        title={`Add to Chat (${addToChatShortcut})`}
                        aria-label="Add to Chat"
                        onMouseDown={(event) => {
                            event.preventDefault();
                            onAddToChat();
                        }}
                        style={{
                            border: "none",
                            borderRadius: 999,
                            background: "transparent",
                            color: "var(--accent)",
                            minWidth: 36,
                            height: 26,
                            padding: "0 8px",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 4,
                            letterSpacing: "-0.01em",
                            whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(event) => {
                            event.currentTarget.style.background =
                                "var(--bg-tertiary)";
                        }}
                        onMouseLeave={(event) => {
                            event.currentTarget.style.background =
                                "transparent";
                        }}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M14 1H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1Z" />
                        </svg>
                        Chat
                    </button>
                </>
            )}
        </div>,
        document.body,
    );
}
