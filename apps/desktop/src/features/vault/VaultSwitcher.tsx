import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
    useVaultStore,
    getRecentVaults,
    type RecentVault,
} from "../../app/store/vaultStore";
import { openVaultWindow } from "../../app/detachedWindows";

export function VaultSwitcher() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [isOpen, setIsOpen] = useState(false);
    const [recents, setRecents] = useState<RecentVault[]>([]);
    const ref = useRef<HTMLDivElement>(null);

    const vaultName = vaultPath
        ? (vaultPath.split("/").pop() ?? vaultPath)
        : "No vault";

    // Refresh recents when dropdown opens
    useEffect(() => {
        if (isOpen) setRecents(getRecentVaults());
    }, [isOpen]);

    // Close on click outside or Escape
    useEffect(() => {
        if (!isOpen) return;
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsOpen(false);
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [isOpen]);

    const handleSelectVault = (path: string) => {
        setIsOpen(false);
        if (path === vaultPath) return;
        void openVaultWindow(path);
    };

    const handleOpenVault = async () => {
        setIsOpen(false);
        const selected = await open({ directory: true, title: "Select vault" });
        if (!selected || selected === vaultPath) return;
        void openVaultWindow(selected);
    };

    const menuItem = (
        label: string,
        action: () => void,
        checked = false,
        muted = false,
    ) => (
        <button
            key={label}
            onClick={action}
            className="w-full text-left px-3 py-1.5 text-xs rounded flex items-center gap-2"
            style={{
                color: muted ? "var(--text-secondary)" : "var(--text-primary)",
            }}
            onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = "var(--bg-tertiary)")
            }
            onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "transparent")
            }
        >
            <span style={{ width: 12, flexShrink: 0, color: "var(--accent)" }}>
                {checked ? "✓" : ""}
            </span>
            <span className="truncate">{label}</span>
        </button>
    );

    return (
        <div
            ref={ref}
            style={{
                position: "relative",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
            }}
        >
            {/* Dropdown — opens above the trigger */}
            {isOpen && (
                <div
                    style={{
                        position: "absolute",
                        bottom: "100%",
                        left: 0,
                        right: 0,
                        marginBottom: 4,
                        zIndex: 9999,
                        borderRadius: 8,
                        backgroundColor: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
                        padding: 4,
                    }}
                >
                    {recents.map((v) =>
                        menuItem(
                            v.name,
                            () => handleSelectVault(v.path),
                            v.path === vaultPath,
                        ),
                    )}
                    {recents.length > 0 && (
                        <div
                            style={{
                                height: 1,
                                backgroundColor: "var(--border)",
                                margin: "4px 0",
                            }}
                        />
                    )}
                    {menuItem(
                        "Open vault…",
                        () => void handleOpenVault(),
                        false,
                        true,
                    )}
                </div>
            )}

            {/* Trigger button */}
            <button
                onClick={() => setIsOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ flexShrink: 0 }}
                >
                    <rect
                        x="2"
                        y="3"
                        width="12"
                        height="10"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                    />
                    <path
                        d="M5 7h6M5 9.5h4"
                        stroke="currentColor"
                        strokeWidth="0.9"
                        strokeLinecap="round"
                    />
                </svg>
                <span
                    className="flex-1 text-left truncate"
                    style={{ color: "var(--text-primary)", fontWeight: 500 }}
                >
                    {vaultName}
                </span>
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    style={{ flexShrink: 0 }}
                >
                    <path
                        d="M5 6l3-3 3 3M5 10l3 3 3-3"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>
        </div>
    );
}
