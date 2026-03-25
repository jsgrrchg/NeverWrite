import { useEffect } from "react";
import { useClipImportStore } from "./clipImportStore";

export function ClipNotification() {
    const notice = useClipImportStore((state) => state.notice);
    const clearNotice = useClipImportStore((state) => state.clearNotice);

    useEffect(() => {
        if (!notice) {
            return;
        }

        const timeout = window.setTimeout(() => {
            clearNotice();
        }, 4200);

        return () => {
            window.clearTimeout(timeout);
        };
    }, [clearNotice, notice]);

    if (!notice) {
        return null;
    }

    return (
        <div
            style={{
                position: "fixed",
                top: 20,
                right: 20,
                zIndex: 200,
                width: 320,
                border: "1px solid var(--border)",
                borderRadius: 16,
                background: "var(--bg-elevated)",
                boxShadow: "var(--shadow-soft)",
                padding: 14,
            }}
        >
            <div
                style={{
                    fontSize: 11,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: "var(--text-secondary)",
                }}
            >
                Web clip saved
            </div>
            <div
                style={{
                    marginTop: 6,
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                }}
            >
                {notice.title}
            </div>
            <div
                style={{
                    marginTop: 6,
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--text-secondary)",
                }}
            >
                {notice.message}
            </div>
            <div
                style={{
                    marginTop: 8,
                    fontSize: 12,
                    lineHeight: 1.4,
                    color: "var(--text-secondary)",
                    wordBreak: "break-word",
                }}
            >
                {notice.relativePath}
            </div>
        </div>
    );
}

export default ClipNotification;
