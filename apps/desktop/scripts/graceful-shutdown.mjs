import os from "node:os";

import { isWindows } from "./common.mjs";

/**
 * Amount of time to wait after SIGTERM escalation to SIGKILL. 
 * A child-process that is still alive after this window is force-killed regardless of its state.
 */
export const FORCE_KILL_TIMEOUT_MS = 1500;

/**
 * Last-resort deadline for process.exit(). 
 * Must be strictly greater than `FORCE_KILL_TIMEOUT_MS` so the SIGKILL path has time to run first.
 */
export const FORCED_EXIT_TIMEOUT_MS = FORCE_KILL_TIMEOUT_MS + 500;

/**
 * Send SIGTERM to a child process and schedule a SIGKILL escalation after
 * `FORCE_KILL_TIMEOUT_MS` if the child has not exited on its own.
 *
 * @param {import("node:child_process").ChildProcess | null} child
 * @param {{ pidOnly?: boolean }} [options]
 *   pidOnly – when true only the exact PID is signalled; when false the
 *              entire process group is signalled (non-Windows only).
 */
export function terminateChild(child, { pidOnly = false } = {}) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const pid = child.pid;
    if (typeof pid !== "number") {
        return;
    }

    const groupPid =
        !isWindows && child.__neverwriteDetached === true ? -pid : pid;

    try {
        process.kill(pidOnly ? pid : groupPid, "SIGTERM");
    } catch {}

    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                process.kill(pidOnly ? pid : groupPid, "SIGKILL");
            } catch {}
        }
    }, FORCE_KILL_TIMEOUT_MS).unref();
}

/**
 * Get the exit code corresponding to a given signal.
 * @param {"SIGTERM"|"SIGINT"} signal 
 * @returns {number}
 */
export function signalExitCode(signal) {
    if (isWindows) {
        return 1;
    }
    const num = os.constants.signals[signal];
    return typeof num === "number" ? 128 + num : 1;
}
