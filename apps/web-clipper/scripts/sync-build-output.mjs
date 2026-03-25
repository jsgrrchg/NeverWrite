import { access, cp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, ".output");
const distRoot = path.join(projectRoot, "dist");

const buildTargets = [
    ["chrome-mv3", "chrome-mv3"],
    ["firefox-mv3", "firefox-mv3"],
];

async function assertExists(targetPath) {
    await access(targetPath, constants.F_OK);
}

async function main() {
    await rm(distRoot, { recursive: true, force: true });
    await mkdir(distRoot, { recursive: true });

    for (const [sourceDirName, distDirName] of buildTargets) {
        const sourcePath = path.join(outputRoot, sourceDirName);
        const distPath = path.join(distRoot, distDirName);

        await assertExists(sourcePath);
        await cp(sourcePath, distPath, { recursive: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
