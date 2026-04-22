import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { NativeBackendBridge } from "./nativeBackend";

type VaultEntryKind = "note" | "pdf" | "file" | "folder";

interface NoteDto {
    id: string;
    path: string;
    title: string;
    modified_at: number;
    created_at: number;
}

interface NoteDetailDto extends NoteDto {
    content: string;
    tags: string[];
    links: string[];
    frontmatter: unknown | null;
}

interface VaultEntryDto {
    id: string;
    path: string;
    relative_path: string;
    title: string;
    file_name: string;
    extension: string;
    kind: VaultEntryKind;
    modified_at: number;
    created_at: number;
    size: number;
    mime_type: string | null;
    is_text_like: boolean | null;
    is_image_like: boolean | null;
    open_in_app: boolean | null;
    viewer_kind: string | null;
}

interface VaultOpenState {
    path: string | null;
    stage:
        | "idle"
        | "scanning"
        | "parsing"
        | "indexing"
        | "saving_snapshot"
        | "ready"
        | "error"
        | "cancelled";
    message: string;
    processed: number;
    total: number;
    note_count: number;
    snapshot_used: boolean;
    cancelled: boolean;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    metrics: {
        scan_ms: number;
        snapshot_load_ms: number;
        parse_ms: number;
        index_ms: number;
        snapshot_save_ms: number;
    };
    error: string | null;
}

interface SearchResultDto {
    id: string;
    path: string;
    title: string;
    kind: string;
    score: number;
}

interface MapEntryDto {
    id: string;
    title: string;
    relative_path: string;
}

interface VaultSnapshot {
    root: string;
    notes: NoteDto[];
    entries: VaultEntryDto[];
    graphRevision: number;
}

interface VaultNoteChange {
    vault_path: string;
    kind: "upsert" | "delete";
    note: NoteDto | null;
    note_id: string | null;
    entry: VaultEntryDto | null;
    relative_path: string | null;
    origin: "user" | "agent" | "external" | "system" | "unknown";
    op_id: string | null;
    revision: number;
    content_hash: string | null;
    graph_revision: number;
}

const ignoredDirNames = new Set([
    ".obsidian",
    ".git",
    ".neverwrite",
    ".neverwrite-cache",
    ".trash",
    "target",
    "node_modules",
    "vendor",
    ".cargo-home",
    ".claude",
]);

const openStates = new Map<string, VaultOpenState>();
const snapshots = new Map<string, VaultSnapshot>();
const revisions = new Map<string, number>();

const VAULT_EDITOR_COMMANDS = new Set([
    "ping",
    "debug_set_timing",
    "open_vault",
    "start_open_vault",
    "cancel_open_vault",
    "get_vault_open_state",
    "list_notes",
    "get_graph_revision",
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
]);

function isStrictSidecarMode() {
    return (
        app.isPackaged ||
        process.env.NEVERWRITE_ELECTRON_STRICT_SIDECAR === "1" ||
        process.env.NEVERWRITE_ELECTRON_STRICT_SIDECAR === "true"
    );
}

const idleOpenState: VaultOpenState = {
    path: null,
    stage: "idle",
    message: "",
    processed: 0,
    total: 0,
    note_count: 0,
    snapshot_used: false,
    cancelled: false,
    started_at_ms: null,
    finished_at_ms: null,
    metrics: {
        scan_ms: 0,
        snapshot_load_ms: 0,
        parse_ms: 0,
        index_ms: 0,
        snapshot_save_ms: 0,
    },
    error: null,
};

function normalizePathForDto(value: string) {
    return value.split(path.sep).join("/");
}

function toAbsoluteVaultPath(vaultPath: string) {
    if (!vaultPath || typeof vaultPath !== "string") {
        throw new Error("Vault path is required.");
    }
    return path.resolve(vaultPath);
}

function ensureRelativePath(relativePath: string, allowEmpty = false) {
    if (typeof relativePath !== "string") {
        throw new Error("Relative path is required.");
    }
    if (!allowEmpty && relativePath.trim() === "") {
        throw new Error("Relative path is required.");
    }
    if (relativePath.includes("\0") || relativePath.includes("\\")) {
        throw new Error("Invalid relative path.");
    }

    const normalized = path.posix.normalize(relativePath);
    if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        path.posix.isAbsolute(normalized)
    ) {
        throw new Error("Path escapes the vault.");
    }
    if (normalized === "." && !allowEmpty) {
        throw new Error("Invalid relative path.");
    }
    return normalized === "." ? "" : normalized;
}

function resolveVaultScopedPath(
    vaultPath: string,
    relativePath: string,
    allowEmpty = false,
) {
    const root = toAbsoluteVaultPath(vaultPath);
    const normalized = ensureRelativePath(relativePath, allowEmpty);
    const absolutePath = path.resolve(root, normalized);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Path escapes the vault.");
    }
    return { root, absolutePath, relativePath: normalizePathForDto(relative) };
}

function noteIdToRelativePath(noteId: string) {
    const normalized = ensureRelativePath(noteId);
    return normalized.toLowerCase().endsWith(".md")
        ? normalized
        : `${normalized}.md`;
}

function withoutExtension(relativePath: string) {
    const extension = path.posix.extname(relativePath);
    if (!extension) return relativePath;
    return relativePath.slice(0, -extension.length);
}

function getExtension(fileName: string) {
    const extension = path.posix.extname(fileName);
    return extension.startsWith(".")
        ? extension.slice(1).toLowerCase()
        : extension.toLowerCase();
}

function guessMimeType(fileName: string) {
    const lower = fileName.toLowerCase();
    if (
        [
            ".babelrc",
            ".dockerignore",
            ".editorconfig",
            ".eslintignore",
            ".eslintrc",
            ".gitattributes",
            ".gitconfig",
            ".gitignore",
            ".gitmodules",
            ".ignore",
            ".node-version",
            ".npmignore",
            ".npmrc",
            ".prettierignore",
            ".prettierrc",
            ".python-version",
            ".ruby-version",
            ".stylelintrc",
            ".stylelintignore",
            ".terraform-version",
            ".tool-versions",
            ".yarnrc",
            ".bash_profile",
            ".bashrc",
            ".profile",
            ".zprofile",
            ".zshrc",
            "brewfile",
            "cmakelists.txt",
            "containerfile",
            "dockerfile",
            "gemfile",
            "gnumakefile",
            "justfile",
            "makefile",
            "podfile",
            "procfile",
            "rakefile",
        ].includes(lower) ||
        lower === ".env" ||
        lower.startsWith(".env.") ||
        (lower.startsWith(".") &&
            (lower.endsWith("rc") || lower.endsWith("ignore")))
    ) {
        return "text/plain";
    }

    switch (getExtension(lower)) {
        case "md":
        case "mdx":
            return "text/markdown";
        case "txt":
        case "log":
        case "ini":
        case "cfg":
        case "conf":
            return "text/plain";
        case "rs":
            return "text/rust";
        case "js":
        case "cjs":
        case "mjs":
            return "text/javascript";
        case "ts":
        case "tsx":
        case "cts":
        case "mts":
            return "text/typescript";
        case "json":
        case "excalidraw":
            return "application/json";
        case "yaml":
        case "yml":
            return "application/yaml";
        case "toml":
            return "application/toml";
        case "xml":
            return "application/xml";
        case "html":
        case "htm":
            return "text/html";
        case "css":
            return "text/css";
        case "csv":
            return "text/csv";
        case "svg":
            return "image/svg+xml";
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
        case "jpe":
        case "jfif":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "avif":
            return "image/avif";
        case "bmp":
            return "image/bmp";
        case "ico":
            return "image/x-icon";
        case "pdf":
            return "application/pdf";
        case "astro":
        case "bash":
        case "c":
        case "cpp":
        case "cs":
        case "dart":
        case "diff":
        case "go":
        case "java":
        case "jsx":
        case "jsonc":
        case "kt":
        case "lua":
        case "php":
        case "py":
        case "rb":
        case "sh":
        case "sql":
        case "svelte":
        case "swift":
        case "vue":
        case "zsh":
            return "text/plain";
        default:
            return null;
    }
}

function isTextLikeMime(mimeType: string | null) {
    return (
        !!mimeType &&
        (mimeType.startsWith("text/") ||
            mimeType === "application/json" ||
            mimeType === "application/yaml" ||
            mimeType === "application/toml" ||
            mimeType === "application/xml")
    );
}

function classifyEntry(fileName: string, kind: VaultEntryKind) {
    const mimeType = kind === "folder" ? null : guessMimeType(fileName);
    const isTextLike = isTextLikeMime(mimeType);
    const isImageLike = mimeType?.startsWith("image/") ?? false;
    const extension = getExtension(fileName);

    if (kind === "folder") {
        return { mimeType, isTextLike, isImageLike, openInApp: false, viewerKind: "folder" };
    }
    if (kind === "note") {
        return { mimeType, isTextLike, isImageLike, openInApp: true, viewerKind: "markdown" };
    }
    if (kind === "pdf") {
        return { mimeType, isTextLike, isImageLike, openInApp: true, viewerKind: "pdf" };
    }
    if (extension === "excalidraw") {
        return { mimeType, isTextLike, isImageLike, openInApp: true, viewerKind: "map" };
    }
    if (isImageLike) {
        return { mimeType, isTextLike, isImageLike, openInApp: true, viewerKind: "image" };
    }
    if (isTextLike) {
        return { mimeType, isTextLike, isImageLike, openInApp: true, viewerKind: "text" };
    }
    return { mimeType, isTextLike, isImageLike, openInApp: false, viewerKind: "external" };
}

function entryKind(fileName: string, isDirectory: boolean): VaultEntryKind {
    if (isDirectory) return "folder";
    const extension = getExtension(fileName);
    if (extension === "md") return "note";
    if (extension === "pdf") return "pdf";
    return "file";
}

function deriveTitle(filePath: string, content: string) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
        const titleMatch = frontmatterMatch[1]?.match(/^title:\s*(.+)$/m);
        const title = titleMatch?.[1]?.trim().replace(/^["']|["']$/g, "");
        if (title) return title;
    }

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
        if (trimmed && trimmed !== "---") break;
    }

    return path.basename(filePath, path.extname(filePath)) || "Untitled";
}

function extractTags(content: string) {
    return [
        ...new Set(
            [...content.matchAll(/(^|\s)#([A-Za-z0-9_/-]+)/g)]
                .map((match) => match[2])
                .filter((value): value is string => typeof value === "string"),
        ),
    ];
}

function extractLinks(content: string) {
    return [
        ...new Set(
            [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
                .map((match) => match[1]?.trim())
                .filter((value): value is string => !!value),
        ),
    ];
}

async function buildEntry(root: string, absolutePath: string, isDirectory: boolean) {
    const stat = await fs.stat(absolutePath);
    const relativePath = normalizePathForDto(path.relative(root, absolutePath));
    const fileName = path.basename(absolutePath);
    const kind = entryKind(fileName, isDirectory);
    const extension = kind === "folder" ? "" : getExtension(fileName);
    const classification = classifyEntry(fileName, kind);
    const id = kind === "file" || kind === "folder" ? relativePath : withoutExtension(relativePath);
    const title =
        kind === "folder"
            ? fileName
            : path.basename(fileName, path.extname(fileName)) || fileName;

    return {
        id,
        path: absolutePath,
        relative_path: relativePath,
        title,
        file_name: fileName,
        extension,
        kind,
        modified_at: Math.floor(stat.mtimeMs / 1000),
        created_at: Math.floor(stat.birthtimeMs / 1000),
        size: stat.size,
        mime_type: classification.mimeType,
        is_text_like: classification.isTextLike,
        is_image_like: classification.isImageLike,
        open_in_app: classification.openInApp,
        viewer_kind: classification.viewerKind,
    } satisfies VaultEntryDto;
}

async function walkVault(root: string, dir = root): Promise<VaultEntryDto[]> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries: VaultEntryDto[] = [];

    for (const dirent of dirents) {
        if (dirent.isDirectory() && ignoredDirNames.has(dirent.name)) {
            continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
        }

        const absolutePath = path.join(dir, dirent.name);
        entries.push(await buildEntry(root, absolutePath, dirent.isDirectory()));
        if (dirent.isDirectory()) {
            entries.push(...(await walkVault(root, absolutePath)));
        }
    }

    return entries;
}

async function noteFromEntry(entry: VaultEntryDto): Promise<NoteDto> {
    const content = await fs.readFile(entry.path, "utf8").catch(() => "");
    return {
        id: entry.id,
        path: entry.path,
        title: deriveTitle(entry.path, content),
        modified_at: entry.modified_at,
        created_at: entry.created_at,
    };
}

async function scanVault(vaultPath: string): Promise<VaultSnapshot> {
    const root = toAbsoluteVaultPath(vaultPath);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
        throw new Error("Selected vault path is not a directory.");
    }

    const entries = await walkVault(root);
    entries.sort((left, right) => left.id.localeCompare(right.id));
    const notes = await Promise.all(
        entries.filter((entry) => entry.kind === "note").map(noteFromEntry),
    );
    notes.sort((left, right) => left.id.localeCompare(right.id));

    return { root, entries, notes, graphRevision: 1 };
}

async function refreshSnapshot(vaultPath: string) {
    const snapshot = await scanVault(vaultPath);
    snapshots.set(toAbsoluteVaultPath(vaultPath), snapshot);
    return snapshot;
}

async function getSnapshot(vaultPath: string) {
    const root = toAbsoluteVaultPath(vaultPath);
    const snapshot = snapshots.get(root);
    if (snapshot) return snapshot;
    return refreshSnapshot(root);
}

function nextRevision(vaultPath: string) {
    const root = toAbsoluteVaultPath(vaultPath);
    const next = (revisions.get(root) ?? 0) + 1;
    revisions.set(root, next);
    return next;
}

function contentHash(content: string) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

async function readNoteDetail(vaultPath: string, noteId: string): Promise<NoteDetailDto> {
    const { absolutePath } = resolveVaultScopedPath(vaultPath, noteIdToRelativePath(noteId));
    const content = await fs.readFile(absolutePath, "utf8");
    const stat = await fs.stat(absolutePath);
    return {
        id: withoutExtension(normalizePathForDto(path.relative(toAbsoluteVaultPath(vaultPath), absolutePath))),
        path: absolutePath,
        title: deriveTitle(absolutePath, content),
        modified_at: Math.floor(stat.mtimeMs / 1000),
        created_at: Math.floor(stat.birthtimeMs / 1000),
        content,
        tags: extractTags(content),
        links: extractLinks(content),
        frontmatter: null,
    };
}

async function buildVaultFileDetail(vaultPath: string, relativePath: string) {
    const resolved = resolveVaultScopedPath(vaultPath, relativePath);
    const content = await fs.readFile(resolved.absolutePath, "utf8");
    const stat = await fs.stat(resolved.absolutePath);
    const entry = await buildEntry(resolved.root, resolved.absolutePath, false);
    return {
        path: resolved.absolutePath,
        relative_path: resolved.relativePath,
        file_name: path.basename(resolved.absolutePath),
        mime_type: entry.mime_type,
        content,
        size_bytes: stat.size,
        content_truncated: false,
    };
}

function buildChange(args: {
    vaultPath: string;
    kind: "upsert" | "delete";
    note: NoteDto | null;
    entry: VaultEntryDto | null;
    relativePath: string | null;
    opId?: string | null;
    content?: string | null;
}): VaultNoteChange {
    return {
        vault_path: toAbsoluteVaultPath(args.vaultPath),
        kind: args.kind,
        note: args.note,
        note_id: args.note?.id ?? (args.kind === "delete" ? args.relativePath : null),
        entry: args.entry,
        relative_path: args.relativePath,
        origin: "user",
        op_id: args.opId ?? null,
        revision: nextRevision(args.vaultPath),
        content_hash: args.content == null ? null : contentHash(args.content),
        graph_revision: 1,
    };
}

function emptyTrackedPatch() {
    return {
        linePatch: { edits: [] },
        textRangePatch: { spans: [] },
    };
}

function linePatch(oldText: string, newText: string) {
    if (oldText === newText) return emptyTrackedPatch();
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    let prefix = 0;
    while (
        prefix < oldLines.length &&
        prefix < newLines.length &&
        oldLines[prefix] === newLines[prefix]
    ) {
        prefix += 1;
    }
    let oldSuffix = oldLines.length - 1;
    let newSuffix = newLines.length - 1;
    while (
        oldSuffix >= prefix &&
        newSuffix >= prefix &&
        oldLines[oldSuffix] === newLines[newSuffix]
    ) {
        oldSuffix -= 1;
        newSuffix -= 1;
    }

    return {
        linePatch: {
            edits: [
                {
                    oldStart: prefix,
                    oldEnd: oldSuffix + 1,
                    newStart: prefix,
                    newEnd: newSuffix + 1,
                },
            ],
        },
        textRangePatch: {
            spans: [
                {
                    baseFrom: 0,
                    baseTo: oldText.length,
                    currentFrom: 0,
                    currentTo: newText.length,
                },
            ],
        },
    };
}

function score(query: string, target: string) {
    const normalizedQuery = query.toLowerCase();
    const normalizedTarget = target.toLowerCase();
    if (!normalizedQuery) return 0;
    const index = normalizedTarget.indexOf(normalizedQuery);
    if (index === -1) return 0;
    return 1 / (1 + index) + normalizedQuery.length / Math.max(1, normalizedTarget.length);
}

async function searchNotes(vaultPath: string, query: string): Promise<SearchResultDto[]> {
    const snapshot = await getSnapshot(vaultPath);
    const results: SearchResultDto[] = [];

    for (const note of snapshot.notes) {
        const content = await fs.readFile(note.path, "utf8").catch(() => "");
        const matchScore = Math.max(score(query, note.title), score(query, content) * 0.5);
        if (matchScore > 0) {
            results.push({ id: note.id, path: note.path, title: note.title, kind: "note", score: matchScore });
        }
    }

    for (const entry of snapshot.entries) {
        if (entry.kind === "note") continue;
        const matchScore = Math.max(score(query, entry.title), score(query, entry.relative_path));
        if (matchScore > 0) {
            results.push({ id: entry.id, path: entry.path, title: entry.title, kind: entry.kind, score: matchScore });
        }
    }

    return results.sort((left, right) => right.score - left.score).slice(0, 200);
}

async function listMaps(vaultPath: string): Promise<MapEntryDto[]> {
    const snapshot = await getSnapshot(vaultPath);
    return snapshot.entries
        .filter((entry) => entry.extension === "excalidraw")
        .map((entry) => ({
            id: entry.relative_path,
            title: entry.title,
            relative_path: entry.relative_path,
        }));
}

export class ElectronVaultBackend {
    private readonly emitEvent: (eventName: string, payload: unknown) => void;
    private readonly nativeBackend: NativeBackendBridge | null;

    constructor(
        emitEvent: (eventName: string, payload: unknown) => void,
        nativeBackend: NativeBackendBridge | null = null,
    ) {
        this.emitEvent = emitEvent;
        this.nativeBackend = nativeBackend;
    }

    async invoke(command: string, args: Record<string, unknown> = {}) {
        if (this.nativeBackend?.supports(command)) {
            return this.nativeBackend.invoke(command, args);
        }

        if (VAULT_EDITOR_COMMANDS.has(command)) {
            const sidecarWasRequested =
                this.nativeBackend !== null ||
                process.env.NEVERWRITE_ELECTRON_BACKEND === "sidecar" ||
                Boolean(process.env.NEVERWRITE_NATIVE_BACKEND_PATH);
            if (sidecarWasRequested && isStrictSidecarMode()) {
                throw new Error(
                    `Electron sidecar does not support required vault/editor command: ${command}`,
                );
            }
        }
        console.warn(
            `[electron-backend] Falling back to temporary Node backend for command: ${command}`,
        );

        switch (command) {
            case "debug_set_timing":
                return args.enabled ? "enabled" : "disabled";
            case "start_open_vault":
                return this.startOpenVault(String(args.path ?? ""));
            case "cancel_open_vault":
                return this.cancelOpenVault(String(args.vaultPath ?? ""));
            case "get_vault_open_state":
                return this.getVaultOpenState(String(args.vaultPath ?? ""));
            case "list_notes":
                return (await getSnapshot(String(args.vaultPath ?? ""))).notes;
            case "get_graph_revision":
                return (await getSnapshot(String(args.vaultPath ?? ""))).graphRevision;
            case "list_vault_entries":
                return (await getSnapshot(String(args.vaultPath ?? ""))).entries;
            case "read_vault_entry":
                return this.readVaultEntry(String(args.vaultPath ?? ""), String(args.relativePath ?? args.relative_path ?? ""));
            case "read_vault_file":
                return buildVaultFileDetail(String(args.vaultPath ?? ""), String(args.relativePath ?? args.relative_path ?? ""));
            case "save_vault_file":
                return this.saveVaultFile(args);
            case "read_note":
                return readNoteDetail(String(args.vaultPath ?? ""), String(args.noteId ?? args.note_id ?? ""));
            case "save_note":
                return this.saveNote(args);
            case "create_note":
                return this.createNote(args);
            case "create_folder":
                return this.createFolder(args);
            case "delete_folder":
                return this.deleteFolder(args);
            case "delete_note":
                return this.deleteNote(args);
            case "move_folder":
                return this.moveFolder(args);
            case "rename_note":
                return this.renameNote(args);
            case "convert_note_to_file":
                return this.convertNoteToFile(args);
            case "move_vault_entry":
                return this.moveVaultEntry(args);
            case "move_vault_entry_to_trash":
                return this.moveVaultEntryToTrash(args);
            case "compute_tracked_file_patches":
                return this.computeTrackedFilePatches(args);
            case "search_notes":
                return searchNotes(String(args.vaultPath ?? ""), String(args.query ?? ""));
            case "get_tags":
                return this.getTags(String(args.vaultPath ?? ""));
            case "list_maps":
                return listMaps(String(args.vaultPath ?? ""));
            case "read_map":
                return buildVaultFileDetail(String(args.vaultPath ?? ""), String(args.relativePath ?? args.relative_path ?? "")).then((detail) => detail.content);
            case "save_map":
                await this.saveVaultFile(args);
                return null;
            case "create_map":
                return this.createMap(args);
            case "delete_map":
                return this.deleteMap(args);
            case "sync_recent_vaults":
            case "delete_vault_snapshot":
            case "register_window_vault_route":
            case "unregister_window_vault_route":
                return null;
            case "get_app_update_configuration":
            case "check_for_app_update":
                return {
                    enabled: false,
                    currentVersion: "0.1.0",
                    channel: "electron-spike",
                    endpoint: null,
                    message: "Updates are disabled in the Electron spike.",
                    update: null,
                };
            case "download_and_install_app_update":
                return null;
            default:
                throw new Error(`Electron runtime command is not implemented yet: ${command}`);
        }
    }

    async startOpenVault(rawPath: string) {
        const vaultPath = toAbsoluteVaultPath(rawPath);
        const started = Date.now();
        openStates.set(vaultPath, {
            ...idleOpenState,
            path: vaultPath,
            stage: "scanning",
            message: "Scanning vault...",
            started_at_ms: started,
        });

        try {
            const snapshot = await scanVault(vaultPath);
            snapshots.set(vaultPath, snapshot);
            openStates.set(vaultPath, {
                ...idleOpenState,
                path: vaultPath,
                stage: "ready",
                message: "Vault ready",
                processed: snapshot.entries.length,
                total: snapshot.entries.length,
                note_count: snapshot.notes.length,
                started_at_ms: started,
                finished_at_ms: Date.now(),
                metrics: {
                    scan_ms: Date.now() - started,
                    snapshot_load_ms: 0,
                    parse_ms: 0,
                    index_ms: 0,
                    snapshot_save_ms: 0,
                },
            });
        } catch (error) {
            openStates.set(vaultPath, {
                ...idleOpenState,
                path: vaultPath,
                stage: "error",
                message: "Failed to open vault",
                started_at_ms: started,
                finished_at_ms: Date.now(),
                error: String(error),
            });
            throw error;
        }
    }

    cancelOpenVault(rawPath: string) {
        const vaultPath = rawPath ? toAbsoluteVaultPath(rawPath) : "";
        openStates.set(vaultPath, {
            ...idleOpenState,
            path: vaultPath || null,
            stage: "cancelled",
            message: "Opening cancelled",
            cancelled: true,
            finished_at_ms: Date.now(),
        });
    }

    getVaultOpenState(rawPath: string) {
        const vaultPath = rawPath ? toAbsoluteVaultPath(rawPath) : "";
        return openStates.get(vaultPath) ?? idleOpenState;
    }

    async readVaultEntry(vaultPath: string, relativePath: string) {
        const resolved = resolveVaultScopedPath(vaultPath, relativePath);
        const stat = await fs.stat(resolved.absolutePath);
        return buildEntry(resolved.root, resolved.absolutePath, stat.isDirectory());
    }

    async saveVaultFile(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const relativePath = String(args.relativePath ?? args.relative_path ?? "");
        const content = String(args.content ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, relativePath);
        await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fs.writeFile(resolved.absolutePath, content);
        const snapshot = await refreshSnapshot(vaultPath);
        const entry = snapshot.entries.find((candidate) => candidate.relative_path === resolved.relativePath) ?? null;
        const detail = await buildVaultFileDetail(vaultPath, resolved.relativePath);
        this.emitEvent("vault://note-changed", buildChange({
            vaultPath,
            kind: "upsert",
            note: null,
            entry,
            relativePath: resolved.relativePath,
            opId: typeof args.opId === "string" ? args.opId : null,
            content,
        }));
        return detail;
    }

    async saveNote(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const noteId = String(args.noteId ?? args.note_id ?? "");
        const content = String(args.content ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, noteIdToRelativePath(noteId));
        await fs.writeFile(resolved.absolutePath, content);
        await refreshSnapshot(vaultPath);
        const detail = await readNoteDetail(vaultPath, noteId);
        this.emitEvent("vault://note-changed", buildChange({
            vaultPath,
            kind: "upsert",
            note: detail,
            entry: null,
            relativePath: resolved.relativePath,
            opId: typeof args.opId === "string" ? args.opId : null,
            content,
        }));
        return detail;
    }

    async createNote(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const relativePath = String(args.path ?? "");
        const content = String(args.content ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, relativePath);
        await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fs.writeFile(resolved.absolutePath, content, { flag: "wx" });
        await refreshSnapshot(vaultPath);
        return readNoteDetail(vaultPath, withoutExtension(resolved.relativePath));
    }

    async createFolder(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, String(args.path ?? ""));
        await fs.mkdir(resolved.absolutePath, { recursive: true });
        await refreshSnapshot(vaultPath);
        return buildEntry(resolved.root, resolved.absolutePath, true);
    }

    async deleteFolder(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, String(args.relativePath ?? ""));
        await fs.rm(resolved.absolutePath, { recursive: true, force: true });
        await refreshSnapshot(vaultPath);
    }

    async deleteNote(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const noteId = String(args.noteId ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, noteIdToRelativePath(noteId));
        await fs.rm(resolved.absolutePath, { force: true });
        await refreshSnapshot(vaultPath);
        this.emitEvent("vault://note-changed", buildChange({
            vaultPath,
            kind: "delete",
            note: null,
            entry: null,
            relativePath: resolved.relativePath,
        }));
    }

    async moveFolder(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const source = resolveVaultScopedPath(vaultPath, String(args.relativePath ?? ""));
        const target = resolveVaultScopedPath(vaultPath, String(args.newRelativePath ?? ""));
        await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
        await fs.rename(source.absolutePath, target.absolutePath);
        await refreshSnapshot(vaultPath);
    }

    async renameNote(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const source = resolveVaultScopedPath(vaultPath, noteIdToRelativePath(String(args.noteId ?? "")));
        const target = resolveVaultScopedPath(vaultPath, String(args.newPath ?? ""));
        await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
        await fs.rename(source.absolutePath, target.absolutePath);
        await refreshSnapshot(vaultPath);
        return readNoteDetail(vaultPath, withoutExtension(target.relativePath));
    }

    async convertNoteToFile(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const source = resolveVaultScopedPath(vaultPath, noteIdToRelativePath(String(args.noteId ?? "")));
        const target = resolveVaultScopedPath(vaultPath, String(args.newRelativePath ?? ""));
        await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
        await fs.rename(source.absolutePath, target.absolutePath);
        await refreshSnapshot(vaultPath);
        return buildEntry(target.root, target.absolutePath, false);
    }

    async moveVaultEntry(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const source = resolveVaultScopedPath(vaultPath, String(args.relativePath ?? ""));
        const target = resolveVaultScopedPath(vaultPath, String(args.newRelativePath ?? ""));
        await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
        await fs.rename(source.absolutePath, target.absolutePath);
        await refreshSnapshot(vaultPath);
        const stat = await fs.stat(target.absolutePath);
        return buildEntry(target.root, target.absolutePath, stat.isDirectory());
    }

    async moveVaultEntryToTrash(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const source = resolveVaultScopedPath(vaultPath, String(args.relativePath ?? ""));
        const trashDir = path.join(toAbsoluteVaultPath(vaultPath), ".trash");
        await fs.mkdir(trashDir, { recursive: true });
        const target = path.join(trashDir, `${Date.now()}-${path.basename(source.absolutePath)}`);
        await fs.rename(source.absolutePath, target);
        await refreshSnapshot(vaultPath);
        return null;
    }

    computeTrackedFilePatches(args: Record<string, unknown>) {
        const inputs = Array.isArray(args.inputs) ? args.inputs : [];
        return inputs.map((input) => {
            const candidate = input as { oldText?: unknown; old_text?: unknown; newText?: unknown; new_text?: unknown };
            return linePatch(
                String(candidate.oldText ?? candidate.old_text ?? ""),
                String(candidate.newText ?? candidate.new_text ?? ""),
            );
        });
    }

    async getTags(vaultPath: string) {
        const snapshot = await getSnapshot(vaultPath);
        const tags = new Map<string, Set<string>>();
        for (const note of snapshot.notes) {
            const content = await fs.readFile(note.path, "utf8").catch(() => "");
            for (const tag of extractTags(content)) {
                const noteIds = tags.get(tag) ?? new Set<string>();
                noteIds.add(note.id);
                tags.set(tag, noteIds);
            }
        }
        return [...tags.entries()]
            .map(([tag, noteIds]) => ({
                tag,
                note_ids: [...noteIds].sort(),
            }))
            .sort((left, right) => left.tag.localeCompare(right.tag));
    }

    async createMap(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const rawName = String(args.name ?? "Untitled").trim() || "Untitled";
        const fileName = rawName.endsWith(".excalidraw") ? rawName : `${rawName}.excalidraw`;
        const relativePath = `Excalidraw/${fileName}`;
        const resolved = resolveVaultScopedPath(vaultPath, relativePath);
        await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fs.writeFile(resolved.absolutePath, "{}", { flag: "wx" });
        await refreshSnapshot(vaultPath);
        return { id: relativePath, title: rawName.replace(/\.excalidraw$/i, ""), relative_path: relativePath };
    }

    async deleteMap(args: Record<string, unknown>) {
        const vaultPath = String(args.vaultPath ?? "");
        const resolved = resolveVaultScopedPath(vaultPath, String(args.relativePath ?? args.relative_path ?? ""));
        await fs.rm(resolved.absolutePath, { force: true });
        await refreshSnapshot(vaultPath);
    }
}

export function resolvePreviewFilePath(vaultPath: string, relativePath: string) {
    return resolveVaultScopedPath(vaultPath, relativePath).absolutePath;
}

export function previewMimeType(filePath: string) {
    return guessMimeType(filePath) ?? "application/octet-stream";
}
