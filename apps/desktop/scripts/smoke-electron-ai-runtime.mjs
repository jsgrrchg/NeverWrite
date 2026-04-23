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
    return await withTimeout(result, 5_000, `Timed out waiting for ${command}`);
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
            this.#events.indexOf(event) >= cursor && predicate(event),
          resolve,
        });
      }),
      timeoutMs,
      `Timed out waiting for event: ${label}`,
    );
  }

  async waitNoEventAfter(cursor, predicate, label, timeoutMs = 250) {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    const existing = this.#events.slice(cursor).find(predicate);
    assert(!existing, `Unexpected event: ${label}`);
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
      pending.reject(new Error(message.error || "Sidecar request failed"));
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

function isAiEvent(eventName) {
  return (event) => event.eventName === eventName;
}

function minimalHistory(sessionId) {
  return {
    version: 1,
    session_id: sessionId,
    runtime_id: "codex-acp",
    model_id: "auto",
    mode_id: "default",
    created_at: Date.now(),
    updated_at: Date.now(),
    start_index: 0,
    message_count: 2,
    title: "Smoke prompt",
    custom_title: null,
    preview: "Smoke reply",
    messages: [
      {
        id: "user:1",
        role: "user",
        kind: "text",
        content: "Smoke prompt",
        timestamp: Date.now(),
      },
      {
        id: "assistant:1",
        role: "assistant",
        kind: "text",
        content: "Smoke reply with searchable runtime text",
        timestamp: Date.now(),
      },
    ],
  };
}

async function writeFixtureVault(vaultPath) {
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Files"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Notes", "A.md"), "# Alpha\n");
  await fs.writeFile(
    path.join(vaultPath, "Files", "context.txt"),
    "Context file",
  );
}

async function writeFakeAcpRuntime(runtimeDir) {
  const runtimePath = path.join(
    runtimeDir,
    process.platform === "win32" ? "fake-acp.cmd" : "fake-acp",
  );
  const script =
    process.platform === "win32"
      ? `@echo off\r\nnode "%~dp0\\fake-acp.mjs"\r\n`
      : `#!/usr/bin/env node\nimport "./fake-acp.mjs";\n`;
  const modulePath = path.join(runtimeDir, "fake-acp.mjs");
  await fs.writeFile(runtimePath, script);
  await fs.writeFile(
    modulePath,
    `
import { createInterface } from "node:readline";

const sessionId = "fake-electron-acp-session";
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}
function result(id, value) {
  send({ id, result: value });
}
function option(id, name) {
  return { value: id, name };
}
function configOptions(mode = "default") {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: [option("default", "Default"), option("review", "Review")]
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "auto",
      options: [option("auto", "Auto")]
    }
  ];
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-electron-acp", title: "Fake Electron ACP", version: "0.0.0" }
    });
    return;
  }
  if (message.method === "session/new") {
    result(message.id, {
      sessionId,
      models: {
        currentModelId: "auto",
        availableModels: [{ modelId: "auto", name: "Auto" }]
      },
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "review", name: "Review" }
        ]
      },
      configOptions: configOptions()
    });
    return;
  }
  if (message.method === "session/set_model" || message.method === "session/set_mode") {
    result(message.id, {});
    return;
  }
  if (message.method === "session/set_config_option") {
    result(message.id, { configOptions: configOptions(message.params?.value?.value ?? "default") });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-edit-1",
          title: "Edit Notes/A.md",
          kind: "edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "Notes/A.md",
              oldText: "# Alpha\\n",
              newText: "# Alpha changed\\n"
            }
          ],
          locations: [{ path: "Notes/A.md" }]
        }
      }
    });
    send({
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Smoke reply with real ACP stream" }
        }
      }
    });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (message.method === "session/cancel") return;
  send({
    id: message.id,
    error: { code: -32601, message: "Method not found" }
  });
});
`.trimStart(),
  );
  await fs.chmod(runtimePath, 0o755).catch(() => {});
  return runtimePath;
}

async function main() {
  await fs.access(sidecarPath).catch(() => {
    throw new Error(
      `Missing sidecar binary at ${sidecarPath}. Run npm run electron:sidecar:build first.`,
    );
  });

  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "neverwrite-ai-"));
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "neverwrite-fake-acp-"),
  );
  const fakeAcpPath = await writeFakeAcpRuntime(runtimeDir);
  await writeFixtureVault(vaultPath);
  const client = new SidecarClient(sidecarPath);

  try {
    await client.invoke("start_open_vault", { path: vaultPath });

    const runtimes = await client.invoke("ai_list_runtimes");
    assert(
      runtimes.some((runtime) => runtime.runtime.id === "codex-acp"),
      "codex runtime descriptor missing",
    );

    const setup = await client.invoke("ai_get_setup_status", {
      runtimeId: "codex-acp",
    });
    assert(setup.runtime_id === "codex-acp", "setup status mismatch");
    const updatedSetup = await client.invoke("ai_update_setup", {
      runtimeId: "codex-acp",
      input: {
        custom_binary_path: fakeAcpPath,
        codex_api_key: { action: "set", value: "smoke-test-key" },
      },
    });
    assert(
      updatedSetup.binary_ready === true && updatedSetup.auth_ready === true,
      "Electron setup should accept a configured ACP runtime",
    );

    const diagnostics = await client.invoke("ai_get_environment_diagnostics");
    assert(
      diagnostics.runtimes.some(
        (runtime) => runtime.runtime_id === "codex-acp",
      ),
      "diagnostics missing codex runtime",
    );

    let cursor = client.eventCursor();
    const session = await client.invoke("ai_create_session", {
      input: {
        runtime_id: "codex-acp",
        additional_roots: null,
      },
      vaultPath,
    });
    assert(session.status === "idle", "session should start idle");
    await client.waitEventAfter(
      cursor,
      isAiEvent("ai://session-created"),
      "session created",
    );

    await client.invoke("ai_set_model", {
      sessionId: session.session_id,
      modelId: "auto",
    });
    await client.invoke("ai_set_mode", {
      sessionId: session.session_id,
      modeId: "review",
    });
    await client.invoke("ai_set_config_option", {
      input: {
        session_id: session.session_id,
        option_id: "mode",
        value: "default",
      },
    });

    await client.waitEventAfter(
      cursor,
      (event) =>
        event.eventName === "ai://runtime-connection" &&
        event.payload?.status === "ready",
      "runtime ready after session create",
    );

    cursor = client.eventCursor();
    await client.invoke("ai_send_message", {
      sessionId: session.session_id,
      content: "Summarize this fixture.",
      attachments: [
        {
          label: "Selected text",
          type: "selection",
          content: "Selected fixture text",
        },
        {
          label: "Context",
          type: "file",
          filePath: path.join(vaultPath, "Files", "context.txt"),
          mimeType: "text/plain",
        },
      ],
    });
    const toolActivity = await client.waitEventAfter(
      cursor,
      (event) =>
        event.eventName === "ai://tool-activity" &&
        event.payload?.tool_call_id === "tool-edit-1",
      "tool activity with file diff",
    );
    const [fileDiff] = toolActivity.payload?.diffs ?? [];
    assert(fileDiff, "tool activity should include file diffs");
    assert(fileDiff.path === "Notes/A.md", "tool activity diff path mismatch");
    assert(fileDiff.kind === "update", "tool activity diff kind mismatch");
    assert(
      fileDiff.old_text === "# Alpha\n" &&
        fileDiff.new_text === "# Alpha changed\n",
      "tool activity should preserve old/new text",
    );
    assert(
      String(toolActivity.payload?.summary ?? "").includes("Notes/A.md"),
      "tool activity should include a visible snippet summary",
    );
    await client.waitEventAfter(
      cursor,
      (event) =>
        event.eventName === "ai://message-delta" &&
        String(event.payload?.delta ?? "").includes("real ACP stream"),
      "real ACP stream delta",
    );
    await client.waitEventAfter(
      cursor,
      isAiEvent("ai://message-completed"),
      "real ACP stream completion",
    );

    const history = minimalHistory(session.session_id);
    await client.invoke("ai_save_session_history", { vaultPath, history });
    const histories = await client.invoke("ai_load_session_histories", {
      vaultPath,
      includeMessages: false,
    });
    assert(histories.length === 1, "history summary should load");
    const page = await client.invoke("ai_load_session_history_page", {
      vaultPath,
      sessionId: session.session_id,
      startIndex: 0,
      limit: 1,
    });
    assert(page.messages.length === 1, "history page should load");
    const search = await client.invoke("ai_search_session_content", {
      vaultPath,
      query: "searchable",
    });
    assert(search.length === 1, "history search should find content");
    const forkedId = await client.invoke("ai_fork_session_history", {
      vaultPath,
      sourceSessionId: session.session_id,
    });
    assert(forkedId !== session.session_id, "fork should create new id");
    await client.invoke("ai_delete_session_history", {
      vaultPath,
      sessionId: forkedId,
    });
    await client.invoke("ai_prune_session_histories", {
      vaultPath,
      maxAgeDays: 1,
    });

    const noteAbsolutePath = path.join(vaultPath, "Notes", "A.md");
    const originalHash = await client.invoke("ai_get_text_file_hash", {
      vaultPath,
      path: noteAbsolutePath,
    });
    cursor = client.eventCursor();
    const restoreChange = await client.invoke("ai_restore_text_file", {
      vaultPath,
      path: noteAbsolutePath,
      previousPath: null,
      content: "# Alpha restored\n",
    });
    assert(
      restoreChange.origin === "agent",
      "restore should emit agent-origin change",
    );
    await client.waitEventAfter(
      cursor,
      (event) =>
        event.eventName === "vault://note-changed" &&
        event.payload?.origin === "agent",
      "agent restore vault change",
    );
    const restoredHash = await client.invoke("ai_get_text_file_hash", {
      vaultPath,
      path: noteAbsolutePath,
    });
    assert(originalHash !== restoredHash, "restore should change file hash");

    await client
      .invoke("ai_start_auth_terminal_session", {
        input: { runtimeId: "codex-acp", vaultPath },
      })
      .then(
        () => {
          throw new Error("auth terminal should be unavailable");
        },
        (error) => {
          assert(
            error.message.includes("not available in Electron"),
            "auth terminal error should be explicit",
          );
        },
      );

    console.log("Electron AI runtime sidecar smoke passed.");
  } finally {
    client.dispose();
    await fs.rm(vaultPath, { recursive: true, force: true });
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
