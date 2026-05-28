import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildDnfRepoRoot, DNF_PUBLIC_KEY_FILE_NAME } from "./dnf-repo-lib.mjs";

function parseArgs(argv) {
    const args = { dnfDir: null, keyId: null };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;
        if (arg === "--dnf-dir") { args.dnfDir = path.resolve(next); index += 1; continue; }
        if (arg === "--key-id") { args.keyId = next?.trim(); index += 1; continue; }
        throw new Error(`Unknown argument "${arg}".`);
    }
    if (!args.dnfDir) throw new Error("Missing --dnf-dir");
    if (!args.keyId) throw new Error("Missing --key-id");
    return args;
}

function runGpg(args, { input = null, stdoutFile = null } = {}) {
    const result = childProcess.spawnSync("gpg", args, {
        input, encoding: stdoutFile ? null : "utf8", maxBuffer: 1024 * 1024 * 16,
    });
    if (result.status !== 0) {
        throw new Error(`gpg failed: ${result.stderr?.toString().trim()}`);
    }
    if (stdoutFile) fs.writeFileSync(stdoutFile, result.stdout);
    return result.stdout;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const repomdPath = path.join(args.dnfDir, "repodata", "repomd.xml");
    const repomdAscPath = path.join(args.dnfDir, "repodata", "repomd.xml.asc");
    const publicKeyPath = path.join(args.dnfDir, DNF_PUBLIC_KEY_FILE_NAME);
    const passphrase = process.env.APT_REPO_GPG_PASSPHRASE ?? "";

    if (!fs.existsSync(repomdPath)) {
        throw new Error(`Missing repomd.xml: ${repomdPath}`);
    }

    const gpgArgs = [
        "--batch", "--yes",
        "--export-options", "export-minimal", "--armor", "--export", args.keyId,
    ];
    runGpg(gpgArgs, { stdoutFile: publicKeyPath });

    const signArgs = [
        "--batch", "--yes", "--armor", "--detach-sign",
        ...(passphrase ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"] : ["--pinentry-mode", "loopback"]),
        "--local-user", args.keyId,
        "--output", repomdAscPath,
        repomdPath,
    ];
    runGpg(signArgs, { input: passphrase ? `${passphrase}\n` : null });

    console.log(`Signed DNF repository: ${repomdAscPath}`);
    console.log(`Wrote public key: ${publicKeyPath}`);
}

main();
