import { useMemo } from "react";
import { openPath, revealItemInDir } from "@neverwrite/runtime";
import { useVaultStore } from "../../app/store/vaultStore";
import { toVaultRelativePath } from "../../app/utils/vaultPaths";
import { buildVaultAssetUrl } from "../../app/utils/filePreviewUrl";
import type { FileTab } from "../../app/store/editorStore";

export function HtmlTabView({ tab }: { tab: FileTab }) {
    const vaultPath = useVaultStore((state) => state.vaultPath);

    const previewUrl = useMemo(() => {
        const relative = toVaultRelativePath(tab.path, vaultPath);
        if (!relative) return null;
        return buildVaultAssetUrl(vaultPath, relative);
    }, [tab.path, vaultPath]);

    return (
        <div className="h-full min-w-0 flex flex-col overflow-hidden">
            <div
                className="flex min-w-0 items-center justify-between gap-2 px-3 shrink-0 overflow-x-auto"
                style={{
                    height: 39,
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--bg-secondary)",
                }}
            >
                <div
                    className="min-w-0 truncate text-[11px]"
                    title={tab.relativePath}
                >
                    <span
                        className="font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {tab.title}
                    </span>
                    <span
                        className="ml-1.5"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {tab.relativePath}
                    </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => void openPath(tab.path)}
                        className="inline-flex items-center rounded px-1.5 text-[10px]"
                        style={headerButtonStyle}
                    >
                        Open Externally
                    </button>
                    <button
                        type="button"
                        onClick={() => void revealItemInDir(tab.path)}
                        className="inline-flex items-center rounded px-1.5 text-[10px]"
                        style={headerButtonStyle}
                    >
                        Reveal in Finder
                    </button>
                </div>
            </div>

            <div className="min-w-0 flex-1 overflow-hidden">
                {previewUrl ? (
                    <iframe
                        key={previewUrl}
                        title={tab.title}
                        src={previewUrl}
                        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                        referrerPolicy="no-referrer"
                        style={{
                            width: "100%",
                            height: "100%",
                            border: "none",
                            backgroundColor: "white",
                        }}
                    />
                ) : (
                    <div
                        className="h-full flex items-center justify-center"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        This file is outside the active vault.
                    </div>
                )}
            </div>
        </div>
    );
}

const headerButtonStyle = {
    height: 22,
    border: "1px solid var(--border)",
    backgroundColor: "transparent",
    color: "var(--text-secondary)",
    cursor: "pointer",
} as const;
