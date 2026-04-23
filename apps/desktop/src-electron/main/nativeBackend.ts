import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app } from "electron";

const SUPPORTED_COMMANDS = new Set([
    "ping",
    "debug_set_timing",
    "open_vault",
    "start_open_vault",
    "cancel_open_vault",
    "get_vault_open_state",
    "list_notes",
    "get_graph_revision",
    "get_graph_snapshot",
    "list_vault_entries",
    "read_vault_entry",
    "read_vault_file",
    "save_vault_file",
    "save_vault_binary_file",
    "read_note",
    "save_note",
    "create_note",
    "create_folder",
    "delete_folder",
    "delete_note",
    "move_folder",
    "copy_folder",
    "rename_note",
    "convert_note_to_file",
    "move_vault_entry",
    "move_vault_entry_to_trash",
    "compute_tracked_file_patches",
    "search_notes",
    "advanced_search",
    "get_tags",
    "get_backlinks",
    "resolve_wikilinks_batch",
    "suggest_wikilinks",
    "list_maps",
    "read_map",
    "save_map",
    "create_map",
    "delete_map",
    "sync_recent_vaults",
    "delete_vault_snapshot",
    "register_window_vault_route",
    "unregister_window_vault_route",
    "get_app_update_configuration",
    "check_for_app_update",
    "download_and_install_app_update",
    "ai_list_runtimes",
    "ai_get_setup_status",
    "ai_get_environment_diagnostics",
    "ai_update_setup",
    "ai_start_auth",
    "ai_list_sessions",
    "ai_load_session",
    "ai_load_runtime_session",
    "ai_resume_runtime_session",
    "ai_fork_runtime_session",
    "ai_create_session",
    "ai_set_model",
    "ai_set_mode",
    "ai_set_config_option",
    "ai_send_message",
    "ai_cancel_turn",
    "ai_respond_permission",
    "ai_respond_user_input",
    "ai_save_session_history",
    "ai_load_session_histories",
    "ai_load_session_history_page",
    "ai_search_session_content",
    "ai_fork_session_history",
    "ai_delete_session_history",
    "ai_delete_all_session_histories",
    "ai_delete_runtime_session",
    "ai_delete_runtime_sessions_for_vault",
    "ai_prune_session_histories",
    "ai_register_file_baseline",
    "ai_get_text_file_hash",
    "ai_restore_text_file",
    "ai_start_auth_terminal_session",
    "ai_write_auth_terminal_session",
    "ai_resize_auth_terminal_session",
    "ai_close_auth_terminal_session",
    "ai_get_auth_terminal_session_snapshot",
    "devtools_create_terminal_session",
    "devtools_write_terminal_session",
    "devtools_resize_terminal_session",
    "devtools_restart_terminal_session",
    "devtools_close_terminal_session",
    "devtools_get_terminal_session_snapshot",
    "spellcheck_list_languages",
    "spellcheck_list_catalog",
    "spellcheck_check_text",
    "spellcheck_suggest",
    "spellcheck_add_to_dictionary",
    "spellcheck_remove_from_dictionary",
    "spellcheck_ignore_word",
    "spellcheck_get_runtime_directory",
    "spellcheck_install_dictionary",
    "spellcheck_remove_installed_dictionary",
    "spellcheck_check_grammar",
    "web_clipper_ready_vaults",
    "web_clipper_list_folders",
    "web_clipper_list_tags",
    "web_clipper_save_note",
]);

interface SidecarMessage {
    type?: unknown;
    id?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: unknown;
    eventName?: unknown;
    event_name?: unknown;
    payload?: unknown;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface NativeBackendResolution {
    executablePath: string | null;
    expectedPath: string;
    attemptedPaths: string[];
}

export interface NativeBackendBridge {
    supports(command: string): boolean;
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    dispose(): void;
}

function nativeBackendExecutableName() {
    return process.platform === "win32"
        ? "neverwrite-native-backend.exe"
        : "neverwrite-native-backend";
}

function resolveNativeBackendPath(): NativeBackendResolution {
    const executable = nativeBackendExecutableName();
    const configuredPath = process.env.NEVERWRITE_NATIVE_BACKEND_PATH?.trim();
    if (configuredPath) {
        return {
            executablePath: fs.existsSync(configuredPath) ? configuredPath : null,
            expectedPath: configuredPath,
            attemptedPaths: [configuredPath],
        };
    }

    if (app.isPackaged) {
        const packagedPath = path.join(
            process.resourcesPath,
            "native-backend",
            executable,
        );
        return {
            executablePath: fs.existsSync(packagedPath) ? packagedPath : null,
            expectedPath: packagedPath,
            attemptedPaths: [packagedPath],
        };
    }

    const candidates = [
        path.resolve(process.cwd(), "..", "..", "target", "debug", executable),
        path.resolve(process.cwd(), "..", "..", "target", "release", executable),
        path.resolve(process.cwd(), "target", "debug", executable),
        path.resolve(process.cwd(), "target", "release", executable),
    ];

    return {
        executablePath: candidates.find((candidate) => fs.existsSync(candidate)) ?? null,
        expectedPath: candidates[0],
        attemptedPaths: candidates,
    };
}

function resolveWorkspaceRoot() {
    return app.isPackaged
        ? null
        : path.resolve(app.getAppPath(), "..", "..");
}

class UnavailableNativeBackendBridge implements NativeBackendBridge {
    private readonly message: string;

    constructor(expectedPath: string) {
        this.message = `Native backend is unavailable. Expected sidecar at: ${expectedPath}. Rebuild or reinstall NeverWrite.`;
    }

    supports(command: string) {
        return SUPPORTED_COMMANDS.has(command);
    }

    invoke() {
        return Promise.reject(new Error(this.message));
    }

    dispose() {
        // Nothing to dispose; this bridge exists so startup can continue safely.
    }
}

class NativeBackendSidecar implements NativeBackendBridge {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly emitEvent: (eventName: string, payload: unknown) => void;
    private readonly pending = new Map<number, PendingRequest>();
    private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    private failure: Error | null = null;
    private nextId = 1;
    private closed = false;
    private exited = false;

    constructor(
        executablePath: string,
        emitEvent: (eventName: string, payload: unknown) => void,
    ) {
        this.emitEvent = emitEvent;
        const workspaceRoot = resolveWorkspaceRoot();
        this.child = spawn(executablePath, [], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                NEVERWRITE_APP_DATA_DIR: app.getPath("userData"),
                NEVERWRITE_ELECTRON_ACP_RESOURCE_DIR: path.dirname(executablePath),
                ...(workspaceRoot ? { NEVERWRITE_WORKSPACE_ROOT: workspaceRoot } : {}),
            },
        });

        readline
            .createInterface({ input: this.child.stdout })
            .on("line", (line) => this.handleLine(line));

        this.child.stderr.on("data", (chunk) => {
            console.warn(`[native-backend] ${String(chunk).trimEnd()}`);
        });

        this.child.on("error", (error) => {
            this.closed = true;
            this.failure = new Error(`Native backend failed to start: ${error.message}`);
            console.error(`[native-backend] ${this.failure.message}`);
            this.rejectPending(this.failure);
        });

        this.child.on("exit", (code, signal) => {
            this.closed = true;
            this.exited = true;
            if (this.forceKillTimer) {
                clearTimeout(this.forceKillTimer);
                this.forceKillTimer = null;
            }
            this.failure = new Error(
                `Native backend exited with ${code ?? signal ?? "unknown status"}`,
            );
            this.rejectPending(this.failure);
        });
    }

    supports(command: string) {
        return SUPPORTED_COMMANDS.has(command);
    }

    invoke(command: string, args: Record<string, unknown> = {}) {
        if (this.closed) {
            return Promise.reject(
                this.failure ?? new Error("Native backend is not running."),
            );
        }

        const id = this.nextId++;
        const payload = JSON.stringify({ id, command, args });

        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.child.stdin.write(`${payload}\n`, (error) => {
                if (!error) return;
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    dispose() {
        if (this.closed && this.exited) return;
        this.closed = true;
        this.rejectPending(new Error("Native backend was closed."));

        if (!this.child.stdin.destroyed) {
            this.child.stdin.end();
        }

        if (!this.exited) {
            this.child.kill("SIGTERM");
            if (!this.forceKillTimer) {
                this.forceKillTimer = setTimeout(() => {
                    if (!this.exited) {
                        this.child.kill("SIGKILL");
                    }
                }, 1500);
                this.forceKillTimer.unref();
            }
        }
    }

    private handleLine(line: string) {
        let message: SidecarMessage;
        try {
            message = JSON.parse(line) as SidecarMessage;
        } catch {
            console.warn(`[native-backend] Ignoring malformed message: ${line}`);
            return;
        }

        if (message.type === "event") {
            const eventName =
                typeof message.eventName === "string"
                    ? message.eventName
                    : typeof message.event_name === "string"
                      ? message.event_name
                      : "";
            if (eventName) {
                this.emitEvent(eventName, message.payload);
            }
            return;
        }

        const id = typeof message.id === "number" ? message.id : Number(message.id);
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);

        if (message.ok === true) {
            request.resolve(message.result);
            return;
        }

        request.reject(
            new Error(
                typeof message.error === "string"
                    ? message.error
                    : "Native backend request failed.",
            ),
        );
    }

    private rejectPending(error: Error) {
        for (const request of this.pending.values()) {
            request.reject(error);
        }
        this.pending.clear();
    }
}

export function createNativeBackendSidecar(
    emitEvent: (eventName: string, payload: unknown) => void,
): NativeBackendBridge | null {
    const resolution = resolveNativeBackendPath();
    const explicitlyEnabled =
        process.env.NEVERWRITE_ELECTRON_BACKEND === "sidecar" ||
        Boolean(process.env.NEVERWRITE_NATIVE_BACKEND_PATH);
    const shouldUseSidecar =
        app.isPackaged || explicitlyEnabled || resolution.executablePath != null;
    if (!shouldUseSidecar) return null;

    const executablePath = resolution.executablePath;
    if (!executablePath) {
        console.error(
            `[native-backend] No sidecar executable found. Tried:\n${resolution.attemptedPaths
                .map((candidate) => `- ${candidate}`)
                .join("\n")}`,
        );
        return new UnavailableNativeBackendBridge(resolution.expectedPath);
    }

    const sidecar = new NativeBackendSidecar(executablePath, emitEvent);
    app.once("before-quit", () => sidecar.dispose());
    app.once("will-quit", () => sidecar.dispose());
    process.once("exit", () => sidecar.dispose());
    return sidecar;
}
