import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    useEditorStore,
    isFileTab,
    type FileTab,
} from "../../app/store/editorStore";
import {
    isWheelZoomGesture,
    useWheelZoomModifier,
} from "../../app/hooks/useWheelZoomModifier";
import { formatZoomPercentage } from "../../app/utils/zoom";
import { FileTextTabView } from "./FileTextTabView";

const IMG_MIN_ZOOM = 0.1;
const IMG_MAX_ZOOM = 10;
const IMG_PINCH_SENSITIVITY = 0.0025;
const IMAGE_TOUCH_ACTION = "pan-x pan-y pinch-zoom";

export function FileTabView() {
    const tab = useEditorStore((state) => {
        const current = state.tabs.find(
            (candidate) => candidate.id === state.activeTabId,
        );
        return current && isFileTab(current) ? current : null;
    });

    if (!tab) {
        return (
            <div
                className="h-full flex items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No file tab active
            </div>
        );
    }

    return tab.viewer === "image" ? (
        <ImageFileViewer key={tab.path} tab={tab} />
    ) : (
        <FileTextTabView />
    );
}

function FileHeader({ tab, children }: { tab: FileTab; children?: ReactNode }) {
    return (
        <div
            className="flex items-center justify-between gap-2 px-3 py-2"
            style={{
                borderBottom: "1px solid var(--border)",
                backgroundColor: "var(--bg-secondary)",
            }}
        >
            <div className="min-w-0">
                <div
                    className="text-[13px] font-medium truncate leading-tight"
                    style={{ color: "var(--text-primary)" }}
                >
                    {tab.title}
                </div>
                <div
                    className="text-[11px] truncate leading-tight"
                    style={{ color: "var(--text-secondary)" }}
                    title={tab.relativePath}
                >
                    {tab.relativePath}
                </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
                {children}
                <button
                    type="button"
                    onClick={() => void openPath(tab.path)}
                    className="rounded-md px-2 py-1 text-[11px]"
                    style={headerButtonStyle}
                >
                    Open Externally
                </button>
                <button
                    type="button"
                    onClick={() => void revealItemInDir(tab.path)}
                    className="rounded-md px-2 py-1 text-[11px]"
                    style={headerButtonStyle}
                >
                    Reveal in Finder
                </button>
            </div>
        </div>
    );
}

type ImageMode = "fit" | "zoom";

function ImageFileViewer({ tab }: { tab: FileTab }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const zoomRef = useRef(1);
    const wheelZoomModifierRef = useWheelZoomModifier();

    const [mode, setMode] = useState<ImageMode>("fit");
    const [zoom, setZoom] = useState(1);
    const [status, setStatus] = useState<"loading" | "ready" | "error">(
        "loading",
    );

    const setFit = useCallback(() => setMode("fit"), []);
    const setActual = useCallback(() => {
        setMode("zoom");
        setZoom(1);
        zoomRef.current = 1;
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        function handleWheel(event: WheelEvent) {
            if (!isWheelZoomGesture(event, wheelZoomModifierRef)) return;
            event.preventDefault();

            const prev = zoomRef.current;
            const next = Math.min(
                IMG_MAX_ZOOM,
                Math.max(
                    IMG_MIN_ZOOM,
                    prev * (1 - event.deltaY * IMG_PINCH_SENSITIVITY),
                ),
            );
            zoomRef.current = next;
            setZoom(next);
            setMode("zoom");
        }

        container.addEventListener("wheel", handleWheel, { passive: false });
        return () => container.removeEventListener("wheel", handleWheel);
    }, [wheelZoomModifierRef]);

    const isFit = mode === "fit";
    const zoomPercent = formatZoomPercentage(zoom);

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <FileHeader tab={tab}>
                <button
                    type="button"
                    onClick={setFit}
                    className="rounded-md px-2.5 py-1.5 text-xs"
                    style={isFit ? activeHeaderButtonStyle : headerButtonStyle}
                >
                    Fit
                </button>
                <button
                    type="button"
                    onClick={setActual}
                    className="rounded-md px-2.5 py-1.5 text-xs"
                    style={
                        !isFit && zoom === 1
                            ? activeHeaderButtonStyle
                            : headerButtonStyle
                    }
                >
                    Actual Size
                </button>
                {!isFit && (
                    <span
                        className="text-xs tabular-nums"
                        style={{
                            color: "var(--text-secondary)",
                            minWidth: 48,
                            textAlign: "center",
                        }}
                    >
                        {zoomPercent}
                    </span>
                )}
            </FileHeader>

            <div
                ref={containerRef}
                className="flex-1 overflow-auto"
                style={{
                    background:
                        "radial-gradient(circle at top, color-mix(in srgb, var(--bg-secondary) 92%, white) 0%, var(--bg-primary) 72%)",
                    touchAction: IMAGE_TOUCH_ACTION,
                }}
            >
                {status === "loading" && (
                    <div
                        className="h-full flex items-center justify-center"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Loading image...
                    </div>
                )}
                {status === "error" && (
                    <div
                        className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        <span
                            className="text-[13px] font-medium"
                            style={{ color: "var(--text-primary)" }}
                        >
                            Failed to load image
                        </span>
                        <span className="text-[12px] max-w-sm">
                            This image could not be rendered in the in-app
                            viewer.
                        </span>
                    </div>
                )}
                {isFit ? (
                    <div
                        className="h-full w-full flex items-center justify-center p-6"
                        style={{
                            display: status === "error" ? "none" : undefined,
                        }}
                    >
                        <img
                            src={convertFileSrc(tab.path)}
                            alt={tab.title}
                            draggable={false}
                            onLoad={() => setStatus("ready")}
                            onError={() => setStatus("error")}
                            style={{
                                maxWidth: "100%",
                                maxHeight: "100%",
                                width: "auto",
                                height: "auto",
                                objectFit: "contain",
                                touchAction: IMAGE_TOUCH_ACTION,
                                boxShadow: "0 16px 40px rgba(0, 0, 0, 0.18)",
                            }}
                        />
                    </div>
                ) : (
                    <div
                        className="inline-flex min-w-full min-h-full items-start justify-center p-6"
                        style={{
                            display: status === "error" ? "none" : undefined,
                        }}
                    >
                        <img
                            src={convertFileSrc(tab.path)}
                            alt={tab.title}
                            draggable={false}
                            onLoad={() => setStatus("ready")}
                            onError={() => setStatus("error")}
                            style={{
                                width: "auto",
                                height: "auto",
                                maxWidth: "none",
                                maxHeight: "none",
                                transformOrigin: "center top",
                                transform: `scale(${zoom})`,
                                touchAction: IMAGE_TOUCH_ACTION,
                                boxShadow: "0 16px 40px rgba(0, 0, 0, 0.18)",
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

const headerButtonStyle = {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
} as const;

const activeHeaderButtonStyle = {
    ...headerButtonStyle,
    border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
    backgroundColor: "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))",
} as const;
