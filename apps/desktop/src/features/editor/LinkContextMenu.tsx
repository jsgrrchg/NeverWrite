import { useEffect, useRef, useState, useLayoutEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getViewportSafeMenuPosition } from "../../app/utils/menuPosition";
import { findWikilinkResource } from "./wikilinkResolution";
import { navigateWikilink, openWikilinkInNewTab } from "./wikilinkNavigation";
import type { LinkContextMenuState } from "./editorExtensions";

export function LinkContextMenu({
    menu,
    onClose,
}: {
    menu: LinkContextMenuState;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x: menu.x, y: menu.y });
    const [resolvedLinkState, setResolvedLinkState] = useState<{
        target: string | null;
        kind: "note" | "file" | null;
    }>({
        target: null,
        kind: null,
    });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPosition(
            getViewportSafeMenuPosition(
                menu.x,
                menu.y,
                rect.width,
                rect.height,
            ),
        );
    }, [menu.x, menu.y]);

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
            if (target === document || target === document.documentElement) {
                onClose();
                return;
            }
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

    useEffect(() => {
        let cancelled = false;

        if (!menu.noteTarget) return;

        void findWikilinkResource(menu.noteTarget).then((linkedResource) => {
            if (!cancelled) {
                setResolvedLinkState({
                    target: menu.noteTarget ?? null,
                    kind: linkedResource?.kind ?? null,
                });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [menu.noteTarget]);

    const linkedResourceKind =
        resolvedLinkState.target === menu.noteTarget
            ? resolvedLinkState.kind
            : null;

    const menuItem = (label: string, action: () => void) => (
        <button
            key={label}
            type="button"
            onClick={() => {
                action();
                onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-xs rounded"
            style={{
                color: "var(--text-primary)",
                background: "transparent",
            }}
            onMouseEnter={(event) => {
                event.currentTarget.style.backgroundColor =
                    "var(--bg-tertiary)";
            }}
            onMouseLeave={(event) => {
                event.currentTarget.style.backgroundColor = "transparent";
            }}
        >
            {label}
        </button>
    );

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                top: position.y,
                left: position.x,
                zIndex: 10000,
                minWidth: 180,
                padding: 4,
                borderRadius: 8,
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}
        >
            {menu.noteTarget
                ? menuItem(
                      linkedResourceKind === "file" ? "Open file" : "Open note",
                      () => {
                          void navigateWikilink(menu.noteTarget ?? menu.href);
                      },
                  )
                : menuItem("Open link", () => {
                      void openUrl(menu.href);
                  })}
            {linkedResourceKind &&
                menuItem("Open in new tab", () => {
                    void openWikilinkInNewTab(menu.noteTarget ?? menu.href);
                })}
            {menuItem("Copy link", () => {
                void navigator.clipboard.writeText(menu.href);
            })}
        </div>
    );
}
