import { useEffect, useRef } from "react";

export interface GraphContextMenuState {
    nodeId: string;
    nodeTitle: string;
    x: number;
    y: number;
}

interface GraphContextMenuProps {
    menu: GraphContextMenuState;
    onClose: () => void;
    onOpenNote: (noteId: string, title: string) => void;
    onOpenInNewTab: (noteId: string, title: string) => void;
    onRevealInTree: (noteId: string) => void;
}

const menuItems = [
    { key: "open", label: "Open Note" },
    { key: "new-tab", label: "Open in New Tab" },
    { key: "separator" },
    { key: "reveal", label: "Reveal in File Tree" },
] as const;

export function GraphContextMenu({
    menu,
    onClose,
    onOpenNote,
    onOpenInNewTab,
    onRevealInTree,
}: GraphContextMenuProps) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("mousedown", handleClick);
        window.addEventListener("keydown", handleKey);
        return () => {
            window.removeEventListener("mousedown", handleClick);
            window.removeEventListener("keydown", handleKey);
        };
    }, [onClose]);

    const handleAction = (key: string) => {
        switch (key) {
            case "open":
                onOpenNote(menu.nodeId, menu.nodeTitle);
                break;
            case "new-tab":
                onOpenInNewTab(menu.nodeId, menu.nodeTitle);
                break;
            case "reveal":
                onRevealInTree(menu.nodeId);
                break;
        }
        onClose();
    };

    return (
        <div
            ref={ref}
            style={{
                position: "fixed",
                left: menu.x,
                top: menu.y,
                zIndex: 9999,
                minWidth: 180,
                padding: "4px 0",
                borderRadius: 8,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
            }}
        >
            {menuItems.map((item, i) =>
                item.key === "separator" ? (
                    <div
                        key={i}
                        style={{
                            height: 1,
                            margin: "4px 8px",
                            background: "var(--border)",
                        }}
                    />
                ) : (
                    <button
                        key={item.key}
                        onClick={() => handleAction(item.key)}
                        style={{
                            display: "block",
                            width: "100%",
                            padding: "6px 12px",
                            border: "none",
                            background: "transparent",
                            color: "var(--text-primary)",
                            fontSize: 13,
                            textAlign: "left",
                            cursor: "pointer",
                            borderRadius: 0,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background =
                                "var(--bg-tertiary)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                        }}
                    >
                        {item.label}
                    </button>
                ),
            )}
        </div>
    );
}
