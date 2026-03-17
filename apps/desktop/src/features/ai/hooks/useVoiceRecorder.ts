import { useCallback, useEffect, useRef, useState } from "react";
import { whisperTranscribeRecording } from "../api";

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const dataUrl = reader.result as string;
            // Strip the "data:audio/ogg;base64," prefix
            const base64 = dataUrl.split(",")[1];
            if (base64) resolve(base64);
            else reject(new Error("Failed to encode audio"));
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/** Pick the best supported MIME type for MediaRecorder. */
function pickMimeType(): string {
    const candidates = [
        "audio/ogg; codecs=opus",
        "audio/ogg",
        "audio/webm; codecs=opus",
        "audio/webm",
    ];
    for (const mime of candidates) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return "";
}

const ONSTOP_TIMEOUT_MS = 5_000;

export interface UseVoiceRecorderReturn {
    isRecording: boolean;
    isTranscribing: boolean;
    error: string | null;
    stream: MediaStream | null;
    /** Text from auto-stop transcription. Consumer should clear after handling. */
    autoTranscription: string | null;
    startRecording: () => Promise<void>;
    stopAndTranscribe: () => Promise<string | null>;
    setError: (error: string | null) => void;
    clearAutoTranscription: () => void;
}

const MAX_RECORDING_MS = 2 * 60 * 1000; // 2 minutes

export function useVoiceRecorder(): UseVoiceRecorderReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [autoTranscription, setAutoTranscription] = useState<string | null>(
        null,
    );
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** Release mic tracks and null out refs. Shared by cleanup & stopAndTranscribe. */
    const releaseStream = useCallback(() => {
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) {
                track.stop();
            }
            streamRef.current = null;
        }
        setStream(null);
        recorderRef.current = null;
        chunksRef.current = [];
    }, []);

    const cleanup = useCallback(() => {
        if (autoStopTimerRef.current) {
            clearTimeout(autoStopTimerRef.current);
            autoStopTimerRef.current = null;
        }
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
        }
        releaseStream();
    }, [releaseStream]);

    // Cleanup on unmount
    useEffect(() => cleanup, [cleanup]);

    const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
        if (autoStopTimerRef.current) {
            clearTimeout(autoStopTimerRef.current);
            autoStopTimerRef.current = null;
        }
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
            cleanup();
            setIsRecording(false);
            return null;
        }

        // Wait for the recorder to finish producing data, with a safety timeout
        let blob: Blob;
        try {
            blob = await Promise.race([
                new Promise<Blob>((resolve) => {
                    recorder.onstop = () => {
                        const mime = recorder.mimeType || "audio/ogg";
                        resolve(new Blob(chunksRef.current, { type: mime }));
                    };
                    recorder.stop();
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error("Recorder onstop timed out")),
                        ONSTOP_TIMEOUT_MS,
                    ),
                ),
            ]);
        } catch (e) {
            releaseStream();
            setIsRecording(false);
            setError(`Recording failed: ${e}`);
            return null;
        }

        releaseStream();
        setIsRecording(false);

        // Skip very short recordings (<0.5s worth of data, ~1KB)
        if (blob.size < 1024) {
            return null;
        }

        setIsTranscribing(true);
        setError(null);
        try {
            const base64 = await blobToBase64(blob);
            const result = await whisperTranscribeRecording(base64);
            return result.text.trim();
        } catch (e) {
            setError(`Transcription failed: ${e}`);
            return null;
        } finally {
            setIsTranscribing(false);
        }
    }, [cleanup, releaseStream]);

    const startRecording = useCallback(async () => {
        setError(null);
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            streamRef.current = mediaStream;
            setStream(mediaStream);

            const mimeType = pickMimeType();
            const recorder = mimeType
                ? new MediaRecorder(mediaStream, { mimeType })
                : new MediaRecorder(mediaStream);

            chunksRef.current = [];
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };

            recorderRef.current = recorder;
            recorder.start();
            setIsRecording(true);

            // Auto-stop after max duration — transcribes instead of discarding
            autoStopTimerRef.current = setTimeout(async () => {
                if (
                    recorderRef.current &&
                    recorderRef.current.state === "recording"
                ) {
                    const text = await stopAndTranscribe();
                    if (text) setAutoTranscription(text);
                }
            }, MAX_RECORDING_MS);
        } catch (e) {
            cleanup();
            setError(
                e instanceof DOMException && e.name === "NotAllowedError"
                    ? "Microphone access denied. Check system preferences."
                    : `Could not access microphone: ${e}`,
            );
        }
    }, [cleanup, stopAndTranscribe]);

    const clearAutoTranscription = useCallback(
        () => setAutoTranscription(null),
        [],
    );

    return {
        isRecording,
        isTranscribing,
        error,
        stream,
        autoTranscription,
        startRecording,
        stopAndTranscribe,
        setError,
        clearAutoTranscription,
    };
}
