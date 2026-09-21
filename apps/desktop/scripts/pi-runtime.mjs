import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const appRoot = fileURLToPath(new URL("..", import.meta.url));
export const piDefinitionRoot = path.join(appRoot, "runtimes", "pi");
export const piPackage = "pi-acp";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

export function piRuntimePath() {
    return path.join(appRoot, ".cache", "pi-runtime");
}

function run(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32" && command === "npm",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0
            ? resolve()
            : reject(new Error(`${command} failed (${code ?? signal})`)));
    });
}

export async function piInputs() {
    const files = ["package.json", "package-lock.json"];
    const contents = await Promise.all(
        files.map((name) => fs.readFile(path.join(piDefinitionRoot, name))),
    );
    const definition = JSON.parse(contents[0]);
    const version = definition.dependencies?.[piPackage];
    if (typeof version !== "string") throw new Error("Pi ACP dependency is missing");
    contents.push(await fs.readFile(fileURLToPath(import.meta.url)));
    return {
        version,
        lock: JSON.parse(contents[1]),
        fingerprint: sha256(Buffer.concat(contents)),
    };
}

export async function validatePiRuntime(root, inputs, { requireStamp = false } = {}) {
    inputs ??= await piInputs();
    const manifest = await readJson(path.join(root, "package.json"));
    if (manifest.name !== piPackage || manifest.version !== inputs.version) {
        throw new Error(`Unexpected Pi ACP runtime at ${root}: ${manifest.name}@${manifest.version}`);
    }
    for (const dependency of ["@agentclientprotocol/sdk", "zod"]) {
        await fs.access(path.join(root, "node_modules", dependency, "package.json"));
    }
    for (const [relative, entry] of Object.entries(inputs.lock.packages)) {
        if (!relative || relative === `node_modules/${piPackage}` || entry.dev) continue;
        const installed = await readJson(path.join(root, relative, "package.json"));
        if (installed.version !== entry.version) {
            throw new Error(`Stale Pi ACP dependency: ${relative}`);
        }
    }
    await fs.access(path.join(root, "dist", "index.js"));
    await fs.access(path.join(root, "LICENSE"));
    if (requireStamp) {
        const stamp = await readJson(path.join(root, ".neverwrite-runtime.json"));
        if (stamp.fingerprint !== inputs.fingerprint || stamp.version !== inputs.version) {
            throw new Error(`Stale Pi ACP runtime at ${root}`);
        }
    }
}

export async function preparePiRuntime({ force = false } = {}) {
    const inputs = await piInputs();
    const destination = piRuntimePath();
    if (!force) {
        try {
            await validatePiRuntime(destination, inputs, { requireStamp: true });
            return destination;
        } catch { /* Rebuild incomplete, changed, or stale caches. */ }
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    const lockDirectory = `${destination}.lock`;
    await fs.mkdir(lockDirectory).catch((error) => {
        if (error.code === "EEXIST") {
            throw new Error(`Pi preparation already locked: ${lockDirectory}`);
        }
        throw error;
    });

    let work;
    try {
        work = await fs.mkdtemp(`${destination}.build-`);
        for (const file of ["package.json", "package-lock.json"]) {
            await fs.copyFile(path.join(piDefinitionRoot, file), path.join(work, file));
        }
        await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], work);
        const output = path.join(work, "runtime");
        await fs.cp(path.join(work, "node_modules", piPackage), output, {
            recursive: true,
            dereference: true,
        });
        await fs.rename(path.join(work, "node_modules"), path.join(output, "node_modules"));
        await fs.rm(path.join(output, "node_modules", piPackage), { recursive: true, force: true });
        await fs.rm(path.join(output, "node_modules", ".bin"), { recursive: true, force: true });
        await fs.rm(path.join(output, "node_modules", ".package-lock.json"), { force: true });
        await validatePiRuntime(output, inputs);
        await fs.writeFile(
            path.join(output, ".neverwrite-runtime.json"),
            `${JSON.stringify({ fingerprint: inputs.fingerprint, version: inputs.version }, null, 2)}\n`,
        );

        const previous = `${destination}.previous`;
        await fs.rm(previous, { recursive: true, force: true });
        const hadPrevious = await fs.stat(destination).catch(() => null);
        if (hadPrevious) await fs.rename(destination, previous);
        try {
            await fs.rename(output, destination);
        } catch (error) {
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

export async function resolvePiRuntimeSource({ configuredSource, embeddedSource } = {}) {
    const source = configuredSource || (embeddedSource
        && await fs.stat(embeddedSource).catch(() => null) ? embeddedSource : null);
    if (source) {
        await validatePiRuntime(source);
        return source;
    }
    return preparePiRuntime();
}
