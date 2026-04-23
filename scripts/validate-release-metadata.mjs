import {
    CHANGELOG_PATH,
    collectElectronBuildIssues,
    collectReleaseIdentityIssues,
    collectVersionIssues,
    getChangelogEntry,
    normalizeReleaseTag,
    readElectronBuilderConfig,
    readDesktopReleaseIdentity,
    readDesktopVersions,
    readFile,
} from "./release-metadata-lib.mjs";

function parseArgs(argv) {
    const args = { tag: null };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--tag") {
            args.tag = argv[index + 1] ?? null;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --tag vX.Y.Z`,
        );
    }

    return args;
}

async function main() {
    const { tag } = parseArgs(process.argv.slice(2));
    const tagVersion = tag ? normalizeReleaseTag(tag) : null;
    const versions = readDesktopVersions();
    const releaseIdentity = await readDesktopReleaseIdentity();
    const electronBuilderConfig = await readElectronBuilderConfig();
    const issues = [
        ...collectVersionIssues(versions, tagVersion),
        ...collectReleaseIdentityIssues(releaseIdentity),
        ...collectElectronBuildIssues(electronBuilderConfig),
    ];
    const changelog = readFile(CHANGELOG_PATH);
    const expectedVersion = tagVersion ?? versions.packageJson;
    const changelogEntry = getChangelogEntry(changelog, expectedVersion);

    if (!changelogEntry) {
        issues.push(
            `CHANGELOG.md does not contain a release entry for ${expectedVersion}.`,
        );
    }

    if (issues.length > 0) {
        for (const issue of issues) {
            console.error(`- ${issue}`);
        }

        process.exitCode = 1;
        return;
    }

    console.log(
        `Desktop version sources are aligned at ${versions.packageJson}.`,
    );
    console.log(`CHANGELOG.md contains an entry for ${expectedVersion}.`);
}

await main();
