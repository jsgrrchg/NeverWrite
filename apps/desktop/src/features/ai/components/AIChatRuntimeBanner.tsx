import type { AIRuntimeConnectionState } from "../types";

interface AIChatRuntimeBannerProps {
    connection: AIRuntimeConnectionState;
}

export function AIChatRuntimeBanner({ connection }: AIChatRuntimeBannerProps) {
    if (connection.status === "idle" || connection.status === "ready") {
        return null;
    }

    const tone =
        connection.status === "error"
            ? {
                  border: "#dc2626",
                  background:
                      "color-mix(in srgb, #dc2626 12%, var(--bg-secondary))",
                  color: "#fecaca",
              }
            : {
                  border: "var(--border)",
                  background:
                      "color-mix(in srgb, var(--bg-secondary) 88%, transparent)",
                  color: "var(--text-secondary)",
              };

    return (
        <div className="px-3 pt-2">
            <div
                className="rounded-xl px-3 py-2 text-xs"
                style={{
                    border: `1px solid ${tone.border}`,
                    backgroundColor: tone.background,
                    color: tone.color,
                }}
            >
                {connection.status === "loading"
                    ? "Loading AI runtime..."
                    : connection.message ?? "AI runtime is unavailable."}
            </div>
        </div>
    );
}
