import { useEffect, useRef, useState } from "react";

interface VoiceRecordingOverlayProps {
    stream: MediaStream | null;
    isRecording: boolean;
    isTranscribing: boolean;
    onStop: () => void;
}

const MAX_SECONDS = 120;

export function VoiceRecordingOverlay({
    stream,
    isRecording,
    isTranscribing,
    onStop,
}: VoiceRecordingOverlayProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number>(0);
    const [, setTick] = useState(0);
    const startTimeRef = useRef(0);
    const wasRecordingRef = useRef(false);

    if (isRecording && !wasRecordingRef.current) {
        startTimeRef.current = Date.now();
    }
    wasRecordingRef.current = isRecording;

    // Timer
    useEffect(() => {
        if (!isRecording) return;
        const id = setInterval(() => {
            setTick((current) => current + 1);
        }, 250);
        return () => clearInterval(id);
    }, [isRecording]);

    const elapsed = isRecording
        ? Math.floor((Date.now() - startTimeRef.current) / 1000)
        : 0;

    // Audio analyser + canvas waveform
    useEffect(() => {
        if (!stream || !isRecording) {
            analyserRef.current = null;
            return;
        }

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        return () => {
            void ctx.close();
            audioCtxRef.current = null;
            analyserRef.current = null;
        };
    }, [stream, isRecording]);

    // Draw loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const c = canvas.getContext("2d");
        if (!c) return;

        const dataArray = new Uint8Array(128);

        const draw = () => {
            rafRef.current = requestAnimationFrame(draw);
            const w = canvas.width;
            const h = canvas.height;
            c.clearRect(0, 0, w, h);

            // Get amplitude from analyser (or flat line if transcribing)
            let amplitude = 0;
            if (analyserRef.current && isRecording) {
                analyserRef.current.getByteTimeDomainData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const v = (dataArray[i] - 128) / 128;
                    sum += v * v;
                }
                amplitude = Math.sqrt(sum / dataArray.length);
            }

            // Scale amplitude for visual effect (0 → ~0.5 range)
            const scaledAmp = Math.min(amplitude * 4, 1);

            // Draw sine wave
            const accentColor =
                getComputedStyle(canvas).getPropertyValue("--accent");
            c.strokeStyle = accentColor || "#6366f1";
            c.globalAlpha = isRecording ? 0.6 : 0.25;
            c.lineWidth = 2;
            c.beginPath();

            const midY = h / 2;
            const waveHeight = midY * 0.6 * scaledAmp;
            const time = Date.now() / 600;

            for (let x = 0; x < w; x++) {
                const t = x / w;
                // Taper at edges
                const envelope = Math.sin(t * Math.PI);
                const y =
                    midY +
                    Math.sin(t * Math.PI * 4 + time) * waveHeight * envelope;
                if (x === 0) c.moveTo(x, y);
                else c.lineTo(x, y);
            }
            c.stroke();

            // Flat baseline when silent
            if (scaledAmp < 0.05 || isTranscribing) {
                c.globalAlpha = 0.15;
                c.beginPath();
                c.moveTo(0, midY);
                c.lineTo(w, midY);
                c.stroke();
            }
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(rafRef.current);
    }, [isRecording, isTranscribing]);

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    return (
        <div
            className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center"
            style={{
                zIndex: 10,
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: "inherit",
            }}
        >
            {/* Timer - top right */}
            {isRecording && (
                <div
                    className="absolute"
                    style={{
                        top: 8,
                        right: 12,
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "var(--text-secondary)",
                        opacity: 0.6,
                    }}
                >
                    {formatTime(elapsed)} / {formatTime(MAX_SECONDS)}
                </div>
            )}

            {/* Waveform canvas */}
            <canvas
                ref={canvasRef}
                width={280}
                height={32}
                style={{ width: 280, height: 32 }}
            />

            {/* Status text + action */}
            <div
                className="mt-1 flex items-center gap-2"
                style={{
                    color: "var(--text-secondary)",
                    opacity: 0.6,
                    fontSize: 12,
                }}
            >
                <span>
                    {isTranscribing ? "Transcribing..." : "Listening..."}
                </span>
                {isRecording && (
                    <button
                        type="button"
                        onClick={onStop}
                        className="flex items-center justify-center rounded"
                        style={{
                            width: 18,
                            height: 18,
                            backgroundColor: "#b91c1c",
                            color: "#fff",
                            border: "none",
                            cursor: "pointer",
                        }}
                        aria-label="Stop recording"
                        title="Stop recording"
                    >
                        <svg width="8" height="8" viewBox="0 0 8 8">
                            <rect
                                width="8"
                                height="8"
                                rx="1"
                                fill="currentColor"
                            />
                        </svg>
                    </button>
                )}
                {isTranscribing && (
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        style={{ animation: "spin 1s linear infinite" }}
                    >
                        <path d="M8 1a7 7 0 1 0 7 7" />
                    </svg>
                )}
            </div>
        </div>
    );
}
