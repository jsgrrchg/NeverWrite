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

export interface UseVoiceRecorderReturn {
    isRecording: boolean;
    isTranscribing: boolean;
    error: string | null;
    startRecording: () => Promise<void>;
    stopAndTranscribe: () => Promise<string | null>;
}

const MAX_RECORDING_MS = 2 * 60 * 1000; // 2 minutes

export function useVoiceRecorder(): UseVoiceRecorderReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const cleanup = useCallback(() => {
        if (autoStopTimerRef.current) {
            clearTimeout(autoStopTimerRef.current);
            autoStopTimerRef.current = null;
        }
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
        }
        recorderRef.current = null;
        chunksRef.current = [];
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) {
                track.stop();
            }
            streamRef.current = null;
        }
    }, []);

    // Cleanup on unmount
    useEffect(() => cleanup, [cleanup]);

    const startRecording = useCallback(async () => {
        setError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            streamRef.current = stream;

            const mimeType = pickMimeType();
            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);

            chunksRef.current = [];
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };

            recorderRef.current = recorder;
            recorder.start();
            setIsRecording(true);

            // Auto-stop after max duration — safety net, stops recording
            // but does not transcribe (user must click button while recording)
            autoStopTimerRef.current = setTimeout(() => {
                if (
                    recorderRef.current &&
                    recorderRef.current.state === "recording"
                ) {
                    recorderRef.current.stop();
                    setIsRecording(false);
                    setError("Recording stopped — maximum 2 minutes reached.");
                    cleanup();
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
    }, [cleanup]);

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

        // Wait for the recorder to finish producing data
        const blob = await new Promise<Blob>((resolve) => {
            recorder.onstop = () => {
                const mime = recorder.mimeType || "audio/ogg";
                resolve(new Blob(chunksRef.current, { type: mime }));
            };
            recorder.stop();
        });

        // Release mic
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) {
                track.stop();
            }
            streamRef.current = null;
        }
        recorderRef.current = null;
        chunksRef.current = [];
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
    }, [cleanup]);

    return {
        isRecording,
        isTranscribing,
        error,
        startRecording,
        stopAndTranscribe,
    };
}
