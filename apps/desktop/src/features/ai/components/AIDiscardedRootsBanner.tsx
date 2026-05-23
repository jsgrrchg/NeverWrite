import type {
    DiscardedAdditionalRoot,
    DiscardedAdditionalRootReason,
} from "../types";

interface AIDiscardedRootsBannerProps {
    roots: DiscardedAdditionalRoot[];
    dismissed?: boolean;
    onDismiss: () => void;
}

function reasonLabel(reason: DiscardedAdditionalRootReason): string {
    switch (reason.kind) {
        case "not_found":
            return "no longer accessible (drive disconnected or path removed)";
        case "permission_denied":
            return "could not be accessed (permission denied)";
        case "not_a_directory":
            return "is not a directory";
        case "other":
            return reason.message;
    }
}

export function AIDiscardedRootsBanner({
    roots,
    dismissed,
    onDismiss,
}: AIDiscardedRootsBannerProps) {
    if (dismissed || roots.length === 0) {
        return null;
    }

    return (
        <div className="px-3 pt-2">
            <div
                className="rounded-xl px-3 py-2 text-xs"
                style={{
                    border: "1px solid #d97706",
                    backgroundColor:
                        "color-mix(in srgb, #d97706 12%, var(--bg-secondary))",
                    color: "var(--text-secondary)",
                }}
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                        <div
                            className="mb-1 font-medium"
                            style={{ color: "#fbbf24" }}
                        >
                            {roots.length === 1
                                ? "An approved directory was removed from this session"
                                : `${roots.length} approved directories were removed from this session`}
                        </div>
                        <ul className="space-y-0.5">
                            {roots.map((root) => (
                                <li
                                    key={`${root.raw}:${root.reason.kind}`}
                                    className="font-mono text-[11px]"
                                >
                                    <span>{root.raw}</span>
                                    <span
                                        className="ml-2"
                                        style={{
                                            color: "var(--text-tertiary)",
                                        }}
                                    >
                                        — {reasonLabel(root.reason)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="rounded px-1.5 py-0.5 text-[11px]"
                        style={{
                            border: "1px solid var(--border)",
                            color: "var(--text-secondary)",
                            backgroundColor: "transparent",
                        }}
                        aria-label="Dismiss discarded roots notice"
                    >
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}
