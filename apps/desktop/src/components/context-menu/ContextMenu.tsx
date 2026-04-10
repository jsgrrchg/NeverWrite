import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";

export type ContextMenuEntry =
    | {
          type?: "item";
          label: string;
          action?: () => void;
          danger?: boolean;
          disabled?: boolean;
          children?: ContextMenuEntry[];
      }
    | {
          type: "separator";
      };

export interface ContextMenuState<T = void> {
    x: number;
    y: number;
    payload: T;
}

export function ContextMenu<T>({
    menu,
    entries,
    onClose,
    minWidth = 180,
    maxHeight,
    zIndex = 10000,
}: {
    menu: ContextMenuState<T>;
    entries: ContextMenuEntry[];
    onClose: () => void;
    minWidth?: number;
    maxHeight?: number;
    zIndex?: number;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });
    const [openSubmenuLabel, setOpenSubmenuLabel] = useState<string | null>(
        null,
    );
    const [submenuDirectionByLabel, setSubmenuDirectionByLabel] = useState<
        Record<string, "left" | "right">
    >({});
    const closeAndRunAction = (action?: () => void) => {
        onClose();
        if (!action) return;
        // Provider changes can reorder menu entries; close first so the menu
        // is not rerendered while a submenu click is still in flight.
        queueMicrotask(action);
    };
    const entriesResetKey = entries
        .map((entry) => {
            if (entry.type === "separator") {
                return "separator";
            }
            return `${entry.label}:${entry.disabled ? "1" : "0"}:${
                entry.children?.length ?? 0
            }`;
        })
        .join("|");

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [menu.x, menu.y, entries.length]);

    useEffect(() => {
        setOpenSubmenuLabel(null);
        setSubmenuDirectionByLabel((current) =>
            Object.keys(current).length > 0 ? {} : current,
        );
    }, [menu.x, menu.y, entriesResetKey]);

    useEffect(() => {
        const handleDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        const handleScroll = (event: Event) => {
            const target = event.target;
            // Always close on document-level scroll
            if (target === document || target === document.documentElement) {
                onClose();
                return;
            }
            // Only close if the scrolling element geometrically contains the
            // menu anchor point — ignore unrelated panels (e.g. AI chat streaming)
            if (target instanceof HTMLElement) {
                const rect = target.getBoundingClientRect();
                if (
                    menu.x >= rect.left &&
                    menu.x <= rect.right &&
                    menu.y >= rect.top &&
                    menu.y <= rect.bottom
                ) {
                    onClose();
                }
            }
        };

        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("scroll", handleScroll, true);

        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [onClose, menu.x, menu.y]);

    return createPortal(
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex,
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "stretch",
                width: "fit-content",
                minWidth,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                ...(maxHeight ? { maxHeight, overflowY: "auto" as const } : {}),
            }}
        >
            {entries.map((entry, index) => {
                if (entry.type === "separator") {
                    return (
                        <div
                            key={`separator-${index}`}
                            style={{
                                borderTop: "1px solid var(--border)",
                                margin: "4px 0",
                            }}
                        />
                    );
                }

                const hasChildren =
                    Array.isArray(entry.children) && entry.children.length > 0;
                const submenuDirection =
                    submenuDirectionByLabel[entry.label] ?? "right";

                return (
                    <div
                        key={`${entry.label}-${index}`}
                        style={{ position: "relative" }}
                        onMouseEnter={(event) => {
                            if (!hasChildren || entry.disabled) {
                                setOpenSubmenuLabel(null);
                                return;
                            }
                            const rect = (
                                event.currentTarget as HTMLDivElement
                            ).getBoundingClientRect();
                            const submenuWidth = minWidth;
                            setSubmenuDirectionByLabel((current) => ({
                                ...current,
                                [entry.label]:
                                    rect.right + submenuWidth + 8 >
                                    window.innerWidth
                                        ? "left"
                                        : "right",
                            }));
                            setOpenSubmenuLabel(entry.label);
                        }}
                        onMouseLeave={() => {
                            if (!hasChildren) return;
                            setOpenSubmenuLabel((current) =>
                                current === entry.label ? null : current,
                            );
                        }}
                    >
                        <button
                            type="button"
                            disabled={entry.disabled}
                            onClick={() => {
                                if (entry.disabled) return;
                                if (hasChildren) {
                                    setOpenSubmenuLabel((current) =>
                                        current === entry.label
                                            ? null
                                            : entry.label,
                                    );
                                    return;
                                }
                                closeAndRunAction(entry.action);
                            }}
                            className="text-left px-3 py-1.5 text-xs rounded"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                width: "100%",
                                color: entry.danger
                                    ? "#ef4444"
                                    : "var(--text-primary)",
                                background: "transparent",
                                opacity: entry.disabled ? 0.45 : 1,
                                cursor: entry.disabled ? "default" : "pointer",
                                whiteSpace: "nowrap",
                            }}
                            onMouseEnter={(event) => {
                                if (entry.disabled) return;
                                event.currentTarget.style.backgroundColor =
                                    entry.danger
                                        ? "color-mix(in srgb, #ef4444 10%, var(--bg-secondary))"
                                        : "var(--bg-tertiary)";
                            }}
                            onMouseLeave={(event) => {
                                event.currentTarget.style.backgroundColor =
                                    "transparent";
                            }}
                        >
                            <span>{entry.label}</span>
                            {hasChildren ? (
                                <span
                                    aria-hidden="true"
                                    style={{
                                        fontSize: 10,
                                        opacity: 0.7,
                                        transform:
                                            submenuDirection === "left"
                                                ? "rotate(180deg)"
                                                : "none",
                                    }}
                                >
                                    ›
                                </span>
                            ) : null}
                        </button>
                        {hasChildren && openSubmenuLabel === entry.label ? (
                            <div
                                style={{
                                    position: "absolute",
                                    top: -4,
                                    [submenuDirection === "right"
                                        ? "left"
                                        : "right"]: "calc(100% + 4px)",
                                    zIndex: zIndex + 1,
                                    display: "inline-flex",
                                    flexDirection: "column",
                                    alignItems: "stretch",
                                    width: "fit-content",
                                    minWidth,
                                    padding: 4,
                                    borderRadius: 8,
                                    backgroundColor: "var(--bg-secondary)",
                                    border: "1px solid var(--border)",
                                    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                                }}
                            >
                                {entry.children!.map((child, childIndex) => {
                                    if (child.type === "separator") {
                                        return (
                                            <div
                                                key={`submenu-separator-${childIndex}`}
                                                style={{
                                                    borderTop:
                                                        "1px solid var(--border)",
                                                    margin: "4px 0",
                                                }}
                                            />
                                        );
                                    }

                                    return (
                                        <button
                                            key={`${child.label}-${childIndex}`}
                                            type="button"
                                            disabled={child.disabled}
                                            onClick={() => {
                                                if (child.disabled) return;
                                                closeAndRunAction(child.action);
                                            }}
                                            className="text-left px-3 py-1.5 text-xs rounded"
                                            style={{
                                                display: "block",
                                                color: child.danger
                                                    ? "#ef4444"
                                                    : "var(--text-primary)",
                                                background: "transparent",
                                                opacity: child.disabled
                                                    ? 0.45
                                                    : 1,
                                                cursor: child.disabled
                                                    ? "default"
                                                    : "pointer",
                                                whiteSpace: "nowrap",
                                            }}
                                            onMouseEnter={(event) => {
                                                if (child.disabled) return;
                                                event.currentTarget.style.backgroundColor =
                                                    child.danger
                                                        ? "color-mix(in srgb, #ef4444 10%, var(--bg-secondary))"
                                                        : "var(--bg-tertiary)";
                                            }}
                                            onMouseLeave={(event) => {
                                                event.currentTarget.style.backgroundColor =
                                                    "transparent";
                                            }}
                                        >
                                            {child.label}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
