import { useCallback, useEffect, useState } from "react";
import {
    whisperDownloadModel,
    whisperCancelDownload,
    whisperListModels,
    whisperSetSelectedModel,
    listenToWhisperDownloadProgress,
    listenToWhisperDownloadComplete,
    listenToWhisperDownloadError,
    type WhisperModelDto,
} from "../api";

interface WhisperSetupModalProps {
    open: boolean;
    onClose: () => void;
    onReady: () => void;
}

function formatSize(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `~${Math.round(mb)} MB`;
}

export function WhisperSetupModal({
    open,
    onClose,
    onReady,
}: WhisperSetupModalProps) {
    const [models, setModels] = useState<WhisperModelDto[]>([]);
    const [selectedId, setSelectedId] = useState("base");
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        whisperListModels().then((m) => {
            setModels(m);
            const rec = m.find((x) => x.recommended);
            if (rec) setSelectedId(rec.id);
        });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const unsubs: Array<() => void> = [];

        listenToWhisperDownloadProgress((p) => {
            setProgress(p.progress);
        }).then((u) => unsubs.push(u));

        listenToWhisperDownloadComplete(() => {
            setDownloading(false);
            setProgress(1);
            whisperSetSelectedModel(selectedId).then(() => onReady());
        }).then((u) => unsubs.push(u));

        listenToWhisperDownloadError((p) => {
            setDownloading(false);
            setError(p.error);
        }).then((u) => unsubs.push(u));

        return () => unsubs.forEach((u) => u());
    }, [open, selectedId, onReady]);

    const startDownload = useCallback(async () => {
        setError(null);
        setProgress(0);
        setDownloading(true);
        try {
            await whisperDownloadModel(selectedId);
        } catch (e) {
            setDownloading(false);
            setError(String(e));
        }
    }, [selectedId]);

    const cancel = useCallback(() => {
        if (downloading) {
            whisperCancelDownload();
            setDownloading(false);
        }
        onClose();
    }, [downloading, onClose]);

    if (!open) return null;

    return (
        <>
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 100,
                    backgroundColor: "rgb(0 0 0 / 0.22)",
                    backdropFilter: "blur(4px)",
                }}
                onClick={cancel}
            />
            <div
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 101,
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    paddingTop: "15vh",
                }}
            >
                <div
                    className="rounded-xl border"
                    style={{
                        width: 400,
                        backgroundColor: "var(--bg-primary)",
                        borderColor: "var(--border)",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
                        padding: 24,
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <h2
                        className="text-base font-semibold"
                        style={{ color: "var(--text-primary)", margin: 0 }}
                    >
                        Audio Transcription Setup
                    </h2>
                    <p
                        className="mt-2 text-sm"
                        style={{
                            color: "var(--text-secondary)",
                            margin: "8px 0 16px",
                        }}
                    >
                        VaultAI uses a local AI model to transcribe audio.
                        Choose a model to download:
                    </p>

                    <div className="flex flex-col gap-2">
                        {models.map((model) => (
                            <label
                                key={model.id}
                                className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2"
                                style={{
                                    borderColor:
                                        selectedId === model.id
                                            ? "var(--accent)"
                                            : "var(--border)",
                                    backgroundColor:
                                        selectedId === model.id
                                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                                            : "transparent",
                                    opacity: downloading ? 0.6 : 1,
                                    pointerEvents: downloading
                                        ? "none"
                                        : "auto",
                                }}
                            >
                                <input
                                    type="radio"
                                    name="whisper-model"
                                    checked={selectedId === model.id}
                                    onChange={() => setSelectedId(model.id)}
                                    style={{ accentColor: "var(--accent)" }}
                                />
                                <div className="flex-1">
                                    <div
                                        className="text-sm font-medium"
                                        style={{ color: "var(--text-primary)" }}
                                    >
                                        {model.label}
                                        {model.recommended && (
                                            <span
                                                className="ml-2 text-xs"
                                                style={{
                                                    color: "var(--accent)",
                                                }}
                                            >
                                                Recommended
                                            </span>
                                        )}
                                    </div>
                                    <div
                                        className="text-xs"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        {formatSize(model.sizeBytes)}
                                        {model.downloaded && " — Downloaded"}
                                    </div>
                                </div>
                            </label>
                        ))}
                    </div>

                    {downloading && (
                        <div className="mt-4">
                            <div
                                className="h-1.5 overflow-hidden rounded-full"
                                style={{
                                    backgroundColor:
                                        "color-mix(in srgb, var(--text-secondary) 15%, transparent)",
                                }}
                            >
                                <div
                                    className="h-full rounded-full transition-all"
                                    style={{
                                        width: `${Math.round(progress * 100)}%`,
                                        backgroundColor: "var(--accent)",
                                    }}
                                />
                            </div>
                            <p
                                className="mt-1 text-xs"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Downloading... {Math.round(progress * 100)}%
                            </p>
                        </div>
                    )}

                    {error && (
                        <p
                            className="mt-3 text-xs"
                            style={{ color: "#ef4444" }}
                        >
                            {error}
                        </p>
                    )}

                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={cancel}
                            className="rounded-lg px-4 py-1.5 text-sm"
                            style={{
                                color: "var(--text-secondary)",
                                backgroundColor: "transparent",
                                border: "1px solid var(--border)",
                            }}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={startDownload}
                            disabled={downloading}
                            className="rounded-lg px-4 py-1.5 text-sm font-medium"
                            style={{
                                color: "#fff",
                                backgroundColor: "var(--accent)",
                                border: "none",
                                opacity: downloading ? 0.6 : 1,
                            }}
                        >
                            {downloading ? "Downloading..." : "Download"}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
