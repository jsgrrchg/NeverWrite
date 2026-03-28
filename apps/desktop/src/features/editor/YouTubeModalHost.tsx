import { useEffect, useState } from "react";

import {
    getYouTubeEmbedUrl,
    OPEN_YOUTUBE_MODAL_EVENT,
    type OpenYouTubeModalPayload,
} from "./youtube";

export function YouTubeModalHost() {
    const [video, setVideo] = useState<OpenYouTubeModalPayload | null>(null);

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const customEvent = event as CustomEvent<OpenYouTubeModalPayload>;
            if (!customEvent.detail?.href) return;
            setVideo(customEvent.detail);
        };

        window.addEventListener(OPEN_YOUTUBE_MODAL_EVENT, handleOpen);
        return () =>
            window.removeEventListener(OPEN_YOUTUBE_MODAL_EVENT, handleOpen);
    }, []);

    useEffect(() => {
        if (!video) return;

        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setVideo(null);
            }
        };

        window.addEventListener("keydown", handleKey, true);
        return () => window.removeEventListener("keydown", handleKey, true);
    }, [video]);

    if (!video) return null;

    const embedUrl = getYouTubeEmbedUrl(video.href);
    if (!embedUrl) return null;

    return (
        <div
            className="fixed inset-0 flex items-center justify-center p-6"
            style={{
                zIndex: 10000,
                background: "rgb(0 0 0 / 0.66)",
            }}
            onClick={() => setVideo(null)}
        >
            <div
                className="w-full max-w-5xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 10,
                        color: "white",
                    }}
                >
                    <div
                        style={{
                            fontSize: 14,
                            fontWeight: 700,
                            lineHeight: 1.35,
                            paddingRight: 16,
                        }}
                    >
                        {video.title}
                    </div>
                    <button
                        type="button"
                        onClick={() => setVideo(null)}
                        style={{
                            width: 34,
                            height: 34,
                            borderRadius: 999,
                            border: "1px solid rgb(255 255 255 / 0.18)",
                            background: "rgb(255 255 255 / 0.08)",
                            color: "white",
                            cursor: "pointer",
                            fontSize: 18,
                            lineHeight: 1,
                        }}
                        aria-label="Close video"
                    >
                        ×
                    </button>
                </div>
                <div
                    style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: "16 / 9",
                        borderRadius: 18,
                        overflow: "hidden",
                        border: "1px solid rgb(255 255 255 / 0.08)",
                        boxShadow: "0 24px 80px rgb(0 0 0 / 0.45)",
                        background: "black",
                    }}
                >
                    <iframe
                        title={video.title}
                        src={embedUrl}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        loading="lazy"
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            border: "none",
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
