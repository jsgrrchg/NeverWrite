import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "tar";
import { detectExecutableArchitecture } from "./stage-electron-sidecar-helpers.mjs";

export const appRoot = fileURLToPath(new URL("..", import.meta.url));
export const claudeDefinitionRoot = path.join(appRoot, "runtimes", "claude");
export const claudePackage = "@agentclientprotocol/claude-agent-acp";
const platformPrefix = "@anthropic-ai/claude-agent-sdk-";
const targets = {
    "aarch64-apple-darwin": ["darwin-arm64"],
    "x86_64-apple-darwin": ["darwin-x64"],
    "universal-apple-darwin": ["darwin-arm64", "darwin-x64"],
    "aarch64-pc-windows-msvc": ["win32-arm64"],
    "x86_64-pc-windows-msvc": ["win32-x64"],
    "aarch64-unknown-linux-gnu": ["linux-arm64"],
    "x86_64-unknown-linux-gnu": ["linux-x64"],
};

export function requiredClaudePlatformPackages(target) {
    if (!Object.hasOwn(targets, target)) throw new Error(`Unsupported Claude target: ${target}`);
    return targets[target].map((suffix) => platformPrefix + suffix);
}

export function claudeHostTarget(platform = process.platform, arch = process.arch) {
    const target = Object.keys(targets).find((key) => targets[key].length === 1
        && targets[key][0] === `${platform}-${arch}`);
    if (!target) throw new Error(`Unsupported Claude host: ${platform}/${arch}`);
    return target;
}

export function claudeRuntimePath(target = claudeHostTarget()) {
    requiredClaudePlatformPackages(target);
    return path.join(appRoot, ".cache", "claude-runtime", target);
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const normalizedRuntimeHash = (value) => sha256(
    value.trimEnd().split(/\r?\n/).map((line) => line.trimEnd()).join("\n") + "\n",
);

export function runRuntimeCommand(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve()
            : reject(new Error(`${command} failed (${code ?? signal})`)));
    });
}

export async function claudeInputs(target) {
    requiredClaudePlatformPackages(target);
    const files = ["package.json", "package-lock.json", "baseline.json",
        "patches/checksums.json", "patches/@agentclientprotocol+claude-agent-acp+0.75.1.patch"];
    const contents = await Promise.all(files.map((name) => fs.readFile(path.join(claudeDefinitionRoot, name))));
    // Changes to the preparer or architecture validation also invalidate installs.
    contents.push(await fs.readFile(fileURLToPath(import.meta.url)));
    contents.push(await fs.readFile(new URL("./stage-electron-sidecar-helpers.mjs", import.meta.url)));
    const fingerprint = sha256(Buffer.concat([Buffer.from(target), ...contents]));
    return { fingerprint, lock: JSON.parse(contents[1]), baseline: JSON.parse(contents[2]),
        checksums: JSON.parse(contents[3]) };
}

export async function validateClaudeRuntime(root, target, inputs, { requireStamp = false } = {}) {
    inputs ??= await claudeInputs(target);
    const { lock, baseline } = inputs;
    const manifest = await readJson(path.join(root, "package.json"));
    if (manifest.name !== claudePackage || manifest.version !== baseline.version) {
        throw new Error(`Unexpected Claude runtime at ${root}: ${manifest.name}@${manifest.version}`);
    }
    if (requireStamp) {
        const stamp = await readJson(path.join(root, ".neverwrite-runtime.json"));
        if (stamp.target !== target || stamp.fingerprint !== inputs.fingerprint) {
            throw new Error(`Stale or wrong-target Claude runtime at ${root}`);
        }
    }
    for (const [relative, expected] of Object.entries(baseline.runtimeFiles)) {
        if (normalizedRuntimeHash(await fs.readFile(path.join(root, relative), "utf8")) !== expected) {
            throw new Error(`Claude runtime does not match its patched baseline: ${relative}`);
        }
    }
    const platformPackages = requiredClaudePlatformPackages(target);
    for (const [relative, entry] of Object.entries(lock.packages)) {
        if (!relative || relative === `node_modules/${claudePackage}` || entry.dev) continue;
        if (entry.optional && !platformPackages.includes(relative.replace(/^node_modules\//, ""))) continue;
        const installed = await readJson(path.join(root, relative, "package.json"));
        if (installed.version !== entry.version) throw new Error(`Stale Claude dependency: ${relative}`);
    }
    for (const packageName of platformPackages) {
        const binary = path.join(root, "node_modules", packageName,
            packageName.includes("win32") ? "claude.exe" : "claude");
        const handle = await fs.open(binary, "r");
        let architecture;
        try {
            const header = Buffer.alloc(65536);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            architecture = detectExecutableArchitecture(header.subarray(0, bytesRead));
        } finally { await handle.close(); }
        const expected = packageName.endsWith("arm64") ? "arm64" : "x86_64";
        if (architecture !== expected) throw new Error(`Wrong Claude CLI architecture: ${binary} (${architecture})`);
        if (process.platform !== "win32" && !binary.endsWith(".exe")
            && ((await fs.stat(binary)).mode & 0o111) === 0) {
            throw new Error(`Claude CLI is not executable: ${binary}`);
        }
    }
}

export async function applyClaudePatch(installRoot, checksums) {
    const packageRoot = path.join(installRoot, "node_modules", claudePackage);
    const manifest = await readJson(path.join(packageRoot, "package.json"));
    const toolsFile = path.join(packageRoot, "dist", "tools.js");
    if (manifest.version !== checksums.version || sha256(await fs.readFile(toolsFile)) !== checksums.original) {
        throw new Error("Claude TaskList patch requires the exact, unmodified published runtime");
    }
    await fs.cp(path.join(claudeDefinitionRoot, "patches"), path.join(installRoot, "patches"), { recursive: true });
    await runRuntimeCommand(process.execPath, [path.join(appRoot, "node_modules", "patch-package", "index.js"),
        "--patch-dir", "patches", "--error-on-fail"], installRoot);
    if (sha256(await fs.readFile(toolsFile)) !== checksums.patched) {
        throw new Error("Claude TaskList patch did not produce the expected runtime");
    }
}

async function installForeignPlatformPackage(installRoot, name, entry) {
    if (!entry?.resolved || !entry.integrity?.startsWith("sha512-")) {
        throw new Error(`Missing locked tarball/integrity for ${name}`);
    }
    const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== entry.integrity) {
        throw new Error(`Claude package integrity mismatch: ${name}`);
    }
    const archivePath = path.join(installRoot, "native-package.tgz");
    const destination = path.join(installRoot, "node_modules", name);
    await fs.writeFile(archivePath, archive);
    await fs.mkdir(destination, { recursive: true });
    await extract({ file: archivePath, cwd: destination, strip: 1, strict: true });
    await fs.rm(archivePath);
}

export async function prepareClaudeRuntime(target = claudeHostTarget(), { force = false } = {}) {
    const inputs = await claudeInputs(target);
    const destination = claudeRuntimePath(target);
    if (!force) {
        try {
            await validateClaudeRuntime(destination, target, inputs, { requireStamp: true });
            return destination;
        } catch { /* Rebuild incomplete, changed or stale caches. */ }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const lockDirectory = `${destination}.lock`;
    await fs.mkdir(lockDirectory).catch((error) => {
        if (error.code === "EEXIST") throw new Error(`Claude preparation already locked: ${lockDirectory}. Remove only after the other preparer has stopped.`);
        throw error;
    });
    let work;
    try {
        work = await fs.mkdtemp(`${destination}.build-`);
        for (const file of ["package.json", "package-lock.json"]) {
            await fs.copyFile(path.join(claudeDefinitionRoot, file), path.join(work, file));
        }
        console.log(`Preparing Claude ACP ${inputs.baseline.version} for ${target}`);
        await runRuntimeCommand("npm", ["ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"], work);
        const required = requiredClaudePlatformPackages(target);
        for (const name of required) {
            if (!(await fs.stat(path.join(work, "node_modules", name, "package.json")).catch(() => null))) {
                await installForeignPlatformPackage(work, name, inputs.lock.packages[`node_modules/${name}`]);
            }
        }
        await applyClaudePatch(work, inputs.checksums);
        const output = path.join(work, "runtime");
        await fs.cp(path.join(work, "node_modules", claudePackage), output, { recursive: true, dereference: true });
        // Move the complete installed dependency tree, retaining nested dependencies.
        await fs.rename(path.join(work, "node_modules"), path.join(output, "node_modules"));
        await fs.rm(path.join(output, "node_modules", claudePackage), { recursive: true, force: true });
        await fs.rm(path.join(output, "node_modules", ".bin"), { recursive: true, force: true });
        await fs.rm(path.join(output, "node_modules", ".package-lock.json"), { force: true });
        for (const relative of Object.keys(inputs.lock.packages)) {
            const name = relative.replace(/^node_modules\//, "");
            if (name.startsWith(platformPrefix) && !required.includes(name)) {
                await fs.rm(path.join(output, relative), { recursive: true, force: true });
            }
        }
        await validateClaudeRuntime(output, target, inputs);
        await fs.writeFile(path.join(output, ".neverwrite-runtime.json"), JSON.stringify({
            target, fingerprint: inputs.fingerprint, version: inputs.baseline.version,
        }, null, 2) + "\n");
        // Only replace a prior generation after the entire candidate is validated.
        const previous = `${destination}.previous`;
        await fs.rm(previous, { recursive: true, force: true });
        const hadPrevious = await fs.stat(destination).catch(() => null);
        if (hadPrevious) await fs.rename(destination, previous);
        try { await fs.rename(output, destination); }
        catch (error) {
            if (hadPrevious) await fs.rename(previous, destination);
            throw error;
        }
        await fs.rm(previous, { recursive: true, force: true });
        return destination;
    } finally {
        if (work) await fs.rm(work, { recursive: true, force: true });
        await fs.rm(lockDirectory, { recursive: true, force: true });
    }
}
