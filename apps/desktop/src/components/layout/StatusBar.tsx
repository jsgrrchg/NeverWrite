import { useVaultStore } from "../../app/store/vaultStore";
import { useThemeStore } from "../../app/store/themeStore";
import { useEditorStore } from "../../app/store/editorStore";

export function StatusBar() {
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const mode = useThemeStore((s) => s.mode);
    const setMode = useThemeStore((s) => s.setMode);

    const activeTabTitle = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.title ?? null,
    );
    const activeTabNoteId = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.noteId ?? null,
    );
    const activeTabIsDirty = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.isDirty ?? false,
    );

    const nextMode = {
        system: "light",
        light: "dark",
        dark: "system",
    } as const;
    const modeLabel = { system: "◐", light: "☀", dark: "☾" };

    const vaultName = vaultPath ? vaultPath.split("/").pop() : null;

    return (
        <div
            className="flex items-center justify-between px-3 flex-shrink-0 select-none"
            style={{
                height: 30,
                background:
                    "color-mix(in srgb, var(--bg-tertiary) 88%, transparent)",
                borderTop: "1px solid var(--border)",
                color: "var(--text-secondary)",
                fontSize: 11,
                backdropFilter: "blur(16px)",
            }}
        >
            <div className="flex items-center gap-2 min-w-0">
                {vaultName && (
                    <span
                        style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            background:
                                "color-mix(in srgb, var(--bg-primary) 58%, transparent)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                            flexShrink: 0,
                        }}
                    >
                        {vaultName}
                    </span>
                )}
                {activeTabTitle && (
                    <>
                        <span style={{ opacity: 0.45, flexShrink: 0 }}>•</span>
                        <span
                            className="truncate"
                            style={{ color: "var(--text-primary)" }}
                            title={activeTabNoteId ?? undefined}
                        >
                            {activeTabTitle}
                        </span>
                        {activeTabIsDirty && (
                            <span
                                style={{
                                    width: 7,
                                    height: 7,
                                    borderRadius: 999,
                                    background: "var(--accent)",
                                    flexShrink: 0,
                                }}
                            />
                        )}
                    </>
                )}
            </div>
            <div className="flex items-center gap-1.5">
                <span
                    style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--border)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 46%, transparent)",
                    }}
                >
                    Live
                </span>
                <button
                    onClick={() => setMode(nextMode[mode])}
                    title={`Theme: ${mode}`}
                    className="rounded"
                    style={{
                        width: 26,
                        height: 22,
                        color: "var(--text-secondary)",
                        border: "1px solid transparent",
                        background: "transparent",
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor =
                            "color-mix(in srgb, var(--bg-primary) 60%, transparent)";
                        e.currentTarget.style.borderColor = "var(--border)";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                        e.currentTarget.style.borderColor = "transparent";
                    }}
                >
                    {modeLabel[mode]}
                </button>
            </div>
        </div>
    );
}
