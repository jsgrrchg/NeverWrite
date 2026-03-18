import { useEffect, useRef, useState } from "react";

interface VoiceRecordingOverlayProps {
    stream: MediaStream | null;
    isRecording: boolean;
    isTranscribing: boolean;
    onStop: () => void;
}

const MAX_SECONDS = 120;

/** Smoothed amplitude with fast attack / slow release for responsive visuals */
function smoothAmplitude(prev: number, raw: number): number {
    const attack = 0.6;
    const release = 0.08;
    return raw > prev
        ? prev + (raw - prev) * attack
        : prev + (raw - prev) * release;
}

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
    const smoothedRef = useRef(0);
    const [elapsed, setElapsed] = useState(0);
    const startTimeRef = useRef(0);

    useEffect(() => {
        if (!isRecording) return;
        startTimeRef.current = Date.now();
        const id = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 250);
        return () => clearInterval(id);
    }, [isRecording]);

    const displayElapsed = isRecording ? elapsed : 0;

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
            let rawAmplitude = 0;
            if (analyserRef.current && isRecording) {
                analyserRef.current.getByteTimeDomainData(dataArray);
                let peak = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const v = Math.abs(dataArray[i] - 128) / 128;
                    if (v > peak) peak = v;
                }
                rawAmplitude = peak;
            }

            // Smooth + scale for responsive, visible feedback
            const scaled = Math.min(rawAmplitude * 8, 1);
            smoothedRef.current = smoothAmplitude(smoothedRef.current, scaled);
            const amp = smoothedRef.current;

            const accentColor =
                getComputedStyle(canvas).getPropertyValue("--accent");
            c.strokeStyle = accentColor || "#6366f1";
            c.lineWidth = 2;

            const midY = h / 2;
            const time = Date.now() / 600;

            // Always draw a baseline
            c.globalAlpha = 0.15;
            c.beginPath();
            c.moveTo(0, midY);
            c.lineTo(w, midY);
            c.stroke();

            // Draw sine wave on top
            const waveHeight = midY * 0.85 * Math.max(amp, 0.05);
            c.globalAlpha = isRecording ? 0.4 + amp * 0.5 : 0.25;
            c.lineWidth = 1.5 + amp;
            c.beginPath();

            for (let x = 0; x < w; x++) {
                const t = x / w;
                const envelope = Math.sin(t * Math.PI);
                const y =
                    midY +
                    Math.sin(t * Math.PI * 4 + time) * waveHeight * envelope;
                if (x === 0) c.moveTo(x, y);
                else c.lineTo(x, y);
            }
            c.stroke();
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
                    {formatTime(displayElapsed)} / {formatTime(MAX_SECONDS)}
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
                className="mt-2 flex items-center gap-3"
                style={{
                    color: "var(--text-secondary)",
                    fontSize: 12,
                }}
            >
                {isRecording && (
                    <button
                        type="button"
                        onClick={onStop}
                        className="flex items-center gap-1.5 rounded-full"
                        style={{
                            padding: "4px 12px",
                            backgroundColor: "var(--accent)",
                            color: "#fff",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 500,
                        }}
                        aria-label="Send to transcribe"
                        title="Send to transcribe"
                    >
                        {/* Arrow-up send icon */}
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M8 14V3M3 7l5-5 5 5" />
                        </svg>
                        Send
                    </button>
                )}
                {isTranscribing && (
                    <div
                        className="flex items-center gap-1.5"
                        style={{ opacity: 0.7 }}
                    >
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
                        <span>Transcribing...</span>
                    </div>
                )}
            </div>
        </div>
    );
}
