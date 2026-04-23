import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..", "..");
const sidecarName =
    process.platform === "win32"
        ? "neverwrite-native-backend.exe"
        : "neverwrite-native-backend";
const defaultSidecar = path.join(workspaceRoot, "target", "debug", sidecarName);
const sidecarPath =
    process.env.NEVERWRITE_NATIVE_BACKEND_PATH?.trim() || defaultSidecar;

class SidecarClient {
    #child;
    #nextId = 1;
    #pending = new Map();
    #events = [];
    #eventWaiters = [];
    #stderr = "";

    constructor(executablePath) {
        this.#child = spawn(executablePath, [], {
            cwd: desktopRoot,
            stdio: ["pipe", "pipe", "pipe"],
        });

        createInterface({ input: this.#child.stdout }).on("line", (line) => {
            this.#handleLine(line);
        });
        this.#child.stderr.on("data", (chunk) => {
            this.#stderr += String(chunk);
        });
        this.#child.on("exit", (code, signal) => {
            const error = new Error(
                `Sidecar exited early (${code ?? signal ?? "unknown"}).\n${this.#stderr}`,
            );
            for (const pending of this.#pending.values()) pending.reject(error);
            this.#pending.clear();
        });
    }

    async invoke(command, args = {}) {
        const id = this.#nextId++;
        const payload = JSON.stringify({ id, command, args });
        const result = new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
        });
        this.#child.stdin.write(`${payload}\n`);
        return await withTimeout(
            result,
            5_000,
            `Timed out waiting for ${command}`,
        );
    }

    async waitEvent(predicate, label, timeoutMs = 5_000) {
        return await this.waitEventAfter(0, predicate, label, timeoutMs);
    }

    eventCursor() {
        return this.#events.length;
    }

    async waitEventAfter(cursor, predicate, label, timeoutMs = 5_000) {
        const existing = this.#events.slice(cursor).find(predicate);
        if (existing) return existing;

        return await withTimeout(
            new Promise((resolve) => {
                this.#eventWaiters.push({
                    predicate: (event) =>
                        this.#events.indexOf(event) >= cursor &&
                        predicate(event),
                    resolve,
                });
            }),
            timeoutMs,
            `Timed out waiting for event: ${label}`,
        );
    }

    dispose() {
        this.#child.stdin.end();
        this.#child.kill("SIGTERM");
    }

    #handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            throw new Error(`Malformed sidecar line: ${line}`);
        }

        if (message.type === "event") {
            this.#events.push(message);
            const remaining = [];
            for (const waiter of this.#eventWaiters) {
                if (waiter.predicate(message)) {
                    waiter.resolve(message);
                } else {
                    remaining.push(waiter);
                }
            }
            this.#eventWaiters = remaining;
            return;
        }

        const pending = this.#pending.get(Number(message.id));
        if (!pending) return;
        this.#pending.delete(Number(message.id));
        if (message.ok === true) {
            pending.resolve(message.result);
        } else {
            pending.reject(
                new Error(message.error || "Sidecar request failed"),
            );
        }
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function advancedParams(term) {
    return {
        terms: [{ value: term, negated: false, is_regex: false }],
        tag_filters: [],
        file_filters: [],
        path_filters: [],
        content_searches: [],
        property_filters: [],
        sort_by: "relevance",
        sort_asc: false,
    };
}

function isVaultChange(message, partial) {
    if (message.eventName !== "vault://note-changed") return false;
    return Object.entries(partial).every(
        ([key, value]) => message.payload?.[key] === value,
    );
}

function waitForWatcherSettle() {
    return new Promise((resolve) => setTimeout(resolve, 500));
}

async function writeFixtureVault(vaultPath) {
    await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Files"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "assets"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Excalidraw"), { recursive: true });
    await fs.writeFile(
        path.join(vaultPath, "Notes", "A.md"),
        "# Alpha\n\nLink to [[B]] and #tag-one.\n",
    );
    await fs.writeFile(
        path.join(vaultPath, "Notes", "B.md"),
        "# Beta\n\nBack to [[A]].\n",
    );
    await fs.writeFile(
        path.join(vaultPath, "Files", "plain.txt"),
        "plain text",
    );
    await fs.writeFile(
        path.join(vaultPath, "Files", "data.json"),
        '{"ok":true}',
    );
    await fs.writeFile(
        path.join(vaultPath, "assets", "image.png"),
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            "base64",
        ),
    );
    await fs.writeFile(
        path.join(vaultPath, "assets", "sample.pdf"),
        "%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    );
    await fs.writeFile(
        path.join(vaultPath, "Excalidraw", "Map.excalidraw"),
        "{}",
    );
}

async function main() {
    await fs.access(sidecarPath).catch(() => {
        throw new Error(
            `Missing sidecar binary at ${sidecarPath}. Run npm run electron:sidecar:build first.`,
        );
    });

    const vaultPath = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-vault-"),
    );
    await writeFixtureVault(vaultPath);
    const client = new SidecarClient(sidecarPath);

    try {
        assert((await client.invoke("ping")).ok === true, "ping failed");
        await client.invoke("start_open_vault", { path: vaultPath });
        const openState = await client.invoke("get_vault_open_state", {
            vaultPath,
        });
        assert(openState.stage === "ready", "vault did not open");
        await waitForWatcherSettle();

        const notes = await client.invoke("list_notes", { vaultPath });
        assert(
            notes.some((note) => note.id === "Notes/A"),
            "missing Notes/A",
        );
        const entries = await client.invoke("list_vault_entries", {
            vaultPath,
        });
        assert(
            entries.some((entry) => entry.relative_path === "assets/image.png"),
            "missing image entry",
        );

        const note = await client.invoke("read_note", {
            vaultPath,
            noteId: "Notes/A",
        });
        assert(
            note.content.includes("[[B]]"),
            "read_note returned wrong content",
        );

        let cursor = client.eventCursor();
        await client.invoke("save_note", {
            vaultPath,
            noteId: "Notes/A",
            content: "# Alpha\n\nLink to [[B]] and #tag-one.\nSaved.\n",
        });
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    note_id: "Notes/A",
                    origin: "user",
                }),
            "save_note",
        );

        cursor = client.eventCursor();
        await client.invoke("create_note", {
            vaultPath,
            path: "Notes/C.md",
            content: "# Charlie\n",
        });
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    note_id: "Notes/C",
                    origin: "user",
                }),
            "create_note",
        );

        cursor = client.eventCursor();
        await client.invoke("rename_note", {
            vaultPath,
            noteId: "Notes/C",
            newPath: "Notes/C Renamed.md",
        });
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    note_id: "Notes/C Renamed",
                    origin: "user",
                }),
            "rename_note",
        );

        cursor = client.eventCursor();
        await client.invoke("delete_note", {
            vaultPath,
            noteId: "Notes/C Renamed",
        });
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "delete",
                    note_id: "Notes/C Renamed",
                    origin: "user",
                }),
            "delete_note",
        );

        await client.invoke("create_folder", { vaultPath, path: "Folder" });
        await client.invoke("move_folder", {
            vaultPath,
            relativePath: "Folder",
            newRelativePath: "MovedFolder",
        });
        const copied = await client.invoke("copy_folder", {
            vaultPath,
            relativePath: "MovedFolder",
            newRelativePath: "CopiedFolder",
        });
        assert(
            copied.relative_path === "CopiedFolder",
            "copy_folder returned wrong entry",
        );

        const file = await client.invoke("read_vault_file", {
            vaultPath,
            relativePath: "Files/plain.txt",
        });
        assert(
            file.content === "plain text",
            "read_vault_file returned wrong content",
        );
        await client.invoke("save_vault_file", {
            vaultPath,
            relativePath: "Files/plain.txt",
            content: "updated text",
        });
        cursor = client.eventCursor();
        await client.invoke("save_vault_binary_file", {
            vaultPath,
            relativeDir: "assets",
            fileName: "dropped.bin",
            bytes: [0, 1, 2, 3, 255],
        });
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    relative_path: "assets/dropped.bin",
                    origin: "user",
                }),
            "save_vault_binary_file",
        );
        const movedEntry = await client.invoke("move_vault_entry", {
            vaultPath,
            relativePath: "Files/data.json",
            newRelativePath: "Files/data-renamed.json",
        });
        assert(
            movedEntry.relative_path === "Files/data-renamed.json",
            "move_vault_entry returned wrong entry",
        );
        await client.invoke("move_vault_entry_to_trash", {
            vaultPath,
            relativePath: "Files/data-renamed.json",
        });

        const search = await client.invoke("search_notes", {
            vaultPath,
            query: "Beta",
        });
        assert(
            search.some((result) => result.id === "Notes/B"),
            "search_notes missed B",
        );
        const advanced = await client.invoke("advanced_search", {
            vaultPath,
            params: advancedParams("Alpha"),
        });
        assert(
            advanced.some((result) => result.id === "Notes/A"),
            "advanced_search missed A",
        );
        const tags = await client.invoke("get_tags", { vaultPath });
        assert(
            tags.some((tag) => tag.tag === "tag-one"),
            "get_tags missed tag-one",
        );
        const backlinks = await client.invoke("get_backlinks", {
            vaultPath,
            noteId: "Notes/B",
        });
        assert(
            backlinks.some((backlink) => backlink.id === "Notes/A"),
            "get_backlinks missed A -> B",
        );
        const resolved = await client.invoke("resolve_wikilinks_batch", {
            vaultPath,
            noteId: "Notes/A",
            targets: ["B", "Missing", "B"],
        });
        assert(resolved.length === 2, "resolve_wikilinks_batch did not dedupe");
        assert(
            resolved.some((link) => link.resolved_note_id === "Notes/B"),
            "resolve_wikilinks_batch missed B",
        );
        const suggestions = await client.invoke("suggest_wikilinks", {
            vaultPath,
            noteId: "Notes/A",
            query: "Be",
            limit: 8,
            preferFileName: false,
        });
        assert(
            suggestions.some((suggestion) => suggestion.id === "Notes/B"),
            "suggest_wikilinks missed B",
        );

        const maps = await client.invoke("list_maps", { vaultPath });
        assert(
            maps.some(
                (map) => map.relative_path === "Excalidraw/Map.excalidraw",
            ),
            "list_maps missed fixture map",
        );
        const mapContent = await client.invoke("read_map", {
            vaultPath,
            relativePath: "Excalidraw/Map.excalidraw",
        });
        assert(mapContent === "{}", "read_map returned wrong content");
        await client.invoke("save_map", {
            vaultPath,
            relativePath: "Excalidraw/Map.excalidraw",
            content: '{"type":"excalidraw"}',
        });
        const createdMap = await client.invoke("create_map", {
            vaultPath,
            name: "Sketch",
        });
        assert(
            createdMap.relative_path === "Excalidraw/Sketch.excalidraw",
            "create_map returned wrong path",
        );
        await client.invoke("delete_map", {
            vaultPath,
            relativePath: "Excalidraw/Sketch.excalidraw",
        });

        cursor = client.eventCursor();
        await fs.writeFile(
            path.join(vaultPath, "Notes", "B.md"),
            "# Beta\n\nExternal watcher edit.\n",
        );
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    note_id: "Notes/B",
                    origin: "external",
                }),
            "external watcher edit",
            8_000,
        );

        cursor = client.eventCursor();
        await fs.mkdir(path.join(vaultPath, "ExternalFolder"));
        await client.waitEventAfter(
            cursor,
            (event) =>
                isVaultChange(event, {
                    kind: "upsert",
                    relative_path: "ExternalFolder",
                    origin: "external",
                }) && event.payload?.entry?.kind === "folder",
            "external folder create",
            8_000,
        );
        const externalEntries = await client.invoke("list_vault_entries", {
            vaultPath,
        });
        assert(
            externalEntries.some(
                (entry) => entry.relative_path === "ExternalFolder",
            ),
            "external folder create did not refresh entries",
        );

        console.log("Electron vault/editor sidecar smoke passed.");
    } finally {
        client.dispose();
        await fs.rm(vaultPath, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
