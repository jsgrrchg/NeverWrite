import { useVaultStore } from "../../app/store/vaultStore";
import { useThemeStore } from "../../app/store/themeStore";

export function StatusBar() {
    const { vaultPath } = useVaultStore();
    const { mode, setMode } = useThemeStore();

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
                height: 28,
                backgroundColor: "var(--bg-tertiary)",
                borderTop: "1px solid var(--border)",
                color: "var(--text-secondary)",
                fontSize: 11,
            }}
        >
            <div className="flex items-center gap-2">
                {vaultName && <span>{vaultName}</span>}
            </div>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setMode(nextMode[mode])}
                    title={`Theme: ${mode}`}
                    className="px-1.5 py-0.5 rounded hover:bg-white/10"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {modeLabel[mode]}
                </button>
            </div>
        </div>
    );
}
