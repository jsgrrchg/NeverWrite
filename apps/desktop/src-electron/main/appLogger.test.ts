import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    initializeAppLogger,
    resetAppLoggerForTests,
    sanitizeLogDetail,
    writeAppLog,
    writeRendererLog,
} from "./appLogger";

function makeTempUserDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-logs-"));
}

function readJsonLines(filePath: string) {
    return fs
        .readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("appLogger", () => {
    let tempDir: string | null = null;

    afterEach(() => {
        resetAppLoggerForTests();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    it("writes source-specific JSONL log files under userData/logs", () => {
        tempDir = makeTempUserDataDir();
        const logDir = initializeAppLogger(tempDir);

        writeAppLog("main", "info", "App started", { platform: "test" });
        writeRendererLog({
            level: "error",
            scope: "chat-store",
            message: "resume failed",
            detail: { runtimeId: "codex" },
            windowLabel: "main",
        });

        const mainEntries = readJsonLines(path.join(logDir, "main.log"));
        const rendererEntries = readJsonLines(path.join(logDir, "renderer.log"));

        expect(mainEntries[0]).toMatchObject({
            source: "main",
            level: "info",
            message: "App started",
        });
        expect(rendererEntries[0]).toMatchObject({
            source: "renderer",
            level: "error",
            message: "[chat-store] resume failed",
        });
    });

    it("redacts sensitive transcript-like fields before persisting details", () => {
        expect(
            sanitizeLogDetail({
                runtimeId: "codex",
                message: "private chat message",
                prompt: "private prompt",
                transcript: ["private transcript"],
                nested: {
                    content: "private note body",
                    safe: true,
                },
            }),
        ).toEqual({
            runtimeId: "codex",
            message: "[redacted]",
            prompt: "[redacted]",
            transcript: "[redacted]",
            nested: {
                content: "[redacted]",
                safe: true,
            },
        });
    });

    it("rotates log files after the configured size limit", () => {
        tempDir = makeTempUserDataDir();
        const logDir = initializeAppLogger(tempDir, { maxBytes: 120 });

        writeAppLog("main", "info", "first", { value: "x".repeat(80) });
        writeAppLog("main", "info", "second");

        expect(fs.existsSync(path.join(logDir, "main.old.log"))).toBe(true);
        const entries = readJsonLines(path.join(logDir, "main.log"));
        expect(entries.at(-1)).toMatchObject({ message: "second" });
    });
});
