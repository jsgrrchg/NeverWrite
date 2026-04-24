import { useState, useRef, useEffect, useCallback } from "react";
import { open } from "@neverwrite/runtime";
import {
    useVaultStore,
    getRecentVaults,
    type RecentVault,
} from "../../app/store/vaultStore";
import { openVaultWindow } from "../../app/detachedWindows";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { getPathBaseName } from "../../app/utils/path";

export interface VaultSwitcherProps {
    onOpenSettings?: (section?: string) => void;
    updateAvailable?: boolean;
}

export function VaultSwitcher({
    onOpenSettings,
    updateAvailable = false,
}: VaultSwitcherProps = {}) {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [isOpen, setIsOpen] = useState(false);
    const [recentSearch, setRecentSearch] = useState("");
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        path: string | null;
    }> | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const recents: RecentVault[] = isOpen ? getRecentVaults() : [];
    const normalizedRecentSearch = recentSearch.trim().toLowerCase();
    const filteredRecents = recents.filter((vault) => {
        if (!normalizedRecentSearch) return true;
        return (
            vault.name.toLowerCase().includes(normalizedRecentSearch) ||
            vault.path.toLowerCase().includes(normalizedRecentSearch)
        );
    });

    const vaultName = vaultPath ? getPathBaseName(vaultPath) : "No vault";
    const closeSwitcher = useCallback(() => {
        setIsOpen(false);
        setRecentSearch("");
    }, []);

    // Close on click outside or Escape
    useEffect(() => {
        if (!isOpen) return;
        const handleDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                closeSwitcher();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeSwitcher();
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [closeSwitcher, isOpen]);

    const handleSelectVault = (path: string) => {
        closeSwitcher();
        if (path === vaultPath) return;
        void openVaultWindow(path);
    };

    const handleOpenVault = async () => {
        closeSwitcher();
        const selected = await open({ directory: true, title: "Select vault" });
        if (!selected || selected === vaultPath) return;
        void openVaultWindow(selected);
    };

    const menuItem = (
        label: string,
        action: () => void,
        checked = false,
        muted = false,
        trailing?: React.ReactNode,
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
            <span className="truncate flex-1">{label}</span>
            {trailing}
        </button>
    );

    const handleOpenSettings = () => {
        closeSwitcher();
        onOpenSettings?.(updateAvailable ? "updates" : undefined);
    };

    return (
        <div
            ref={ref}
            style={{
                position: "relative",
                borderTop: "1px solid var(--border)",
                boxShadow: "0 -4px 8px rgba(0,0,0,0.06)",
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
                    {recents.length > 0 && (
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                backgroundColor: "var(--bg-primary)",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                padding: "5px 8px",
                                marginBottom: 4,
                            }}
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                                style={{ opacity: 0.4, flexShrink: 0 }}
                            >
                                <circle
                                    cx="7"
                                    cy="7"
                                    r="5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                                <path
                                    d="m13 13-2.5-2.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                />
                            </svg>
                            <input
                                value={recentSearch}
                                onChange={(event) =>
                                    setRecentSearch(event.target.value)
                                }
                                aria-label="Search vaults"
                                placeholder="Search vaults…"
                                style={{
                                    flex: 1,
                                    border: "none",
                                    background: "transparent",
                                    fontSize: 12,
                                    color: "var(--text-primary)",
                                    outline: "none",
                                    fontFamily: "inherit",
                                    minWidth: 0,
                                }}
                            />
                            <span
                                style={{
                                    fontSize: 10,
                                    color: "var(--text-secondary)",
                                    fontFamily: "monospace",
                                    flexShrink: 0,
                                }}
                            >
                                {filteredRecents.length}/{recents.length}
                            </span>
                        </div>
                    )}
                    {recents.length > 0 && (
                        <div
                            role="list"
                            aria-label="Vault switcher recent vaults"
                            style={{
                                maxHeight: 240,
                                overflowY: "auto",
                            }}
                        >
                            {filteredRecents.length === 0 ? (
                                <div
                                    style={{
                                        padding: "6px 8px 8px",
                                        fontSize: 12,
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    No vaults match your search.
                                </div>
                            ) : (
                                filteredRecents.map((v) => (
                                    <div key={v.path} role="listitem">
                                        {menuItem(
                                            v.name,
                                            () => handleSelectVault(v.path),
                                            v.path === vaultPath,
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
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
                    {onOpenSettings && (
                        <>
                            <div
                                style={{
                                    height: 1,
                                    backgroundColor: "var(--border)",
                                    margin: "4px 0",
                                }}
                            />
                            {menuItem(
                                updateAvailable
                                    ? "Settings · Update available"
                                    : "Settings…",
                                handleOpenSettings,
                                false,
                                true,
                                updateAvailable ? (
                                    <span
                                        aria-hidden="true"
                                        style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: "50%",
                                            background:
                                                "linear-gradient(180deg, #f97316, #ef4444)",
                                            flexShrink: 0,
                                        }}
                                    />
                                ) : undefined,
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Trigger button */}
            <button
                onClick={() =>
                    setIsOpen((open) => {
                        if (open) {
                            setRecentSearch("");
                        }
                        return !open;
                    })
                }
                onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        payload: { path: vaultPath },
                    });
                }}
                className="w-full flex items-center gap-2 px-3 py-3 text-xs"
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
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Open Vault…",
                            action: () => void handleOpenVault(),
                        },
                        {
                            label: "Copy Vault Path",
                            action: () =>
                                void navigator.clipboard.writeText(
                                    contextMenu.payload.path ?? "",
                                ),
                            disabled: !contextMenu.payload.path,
                        },
                    ]}
                />
            )}
        </div>
    );
}
