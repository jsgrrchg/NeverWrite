import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const UPSTREAM_OWNER = "agentclientprotocol";
const UPSTREAM_REPO = "claude-agent-acp";
const UPSTREAM_NAME = `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`;
const VENDORED_PACKAGE_JSON_PATH = path.join(
    REPO_ROOT,
    "vendor/Claude-agent-acp-upstream/package.json",
);
const ISSUE_LABEL = "upstream-update";
const ISSUE_LABEL_COLOR = "0e8a16";
const ISSUE_LABEL_DESCRIPTION = "Tracks vendored upstream dependency updates.";

function parseArgs(argv) {
    const args = { dryRun: false };

    for (const arg of argv) {
        if (arg === "--dry-run") {
            args.dryRun = true;
            continue;
        }

        throw new Error(`Unknown argument "${arg}". Supported args: --dry-run`);
    }

    return args;
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseSemver(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) {
        return null;
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        version: `${match[1]}.${match[2]}.${match[3]}`,
    };
}

function compareSemver(left, right) {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key]) {
            return left[key] - right[key];
        }
    }

    return 0;
}

function getGitHubRepo() {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository || !repository.includes("/")) {
        throw new Error("GITHUB_REPOSITORY must be set to owner/repo.");
    }

    const [owner, repo] = repository.split("/");
    return { owner, repo };
}

function getGitHubToken() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN must be set.");
    }

    return token;
}

async function githubRequest(pathname, options = {}) {
    const token = options.token;
    const response = await fetch(`https://api.github.com${pathname}`, {
        method: options.method ?? "GET",
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    const allowedStatuses = options.allowedStatuses ?? [200];

    if (!allowedStatuses.includes(response.status)) {
        throw new Error(
            `GitHub API request failed: ${response.status} ${response.statusText} ${pathname}\n${text}`,
        );
    }

    return { response, data };
}

async function fetchUpstreamTags() {
    const tags = [];

    for (let page = 1; page <= 10; page += 1) {
        const { data } = await githubRequest(
            `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tags?per_page=100&page=${page}`,
            { allowedStatuses: [200] },
        );

        tags.push(...data);

        if (data.length < 100) {
            break;
        }
    }

    return tags;
}

async function getLatestStableUpstreamTag() {
    const tags = await fetchUpstreamTags();
    const stableTags = tags
        .map((tag) => ({ name: tag.name, semver: parseSemver(tag.name) }))
        .filter((tag) => tag.semver);

    if (stableTags.length === 0) {
        throw new Error(`No stable semver tags found in ${UPSTREAM_NAME}.`);
    }

    stableTags.sort((left, right) => compareSemver(right.semver, left.semver));
    return stableTags[0];
}

async function findOpenIssueByTitle(owner, repo, title, token) {
    const query = new URLSearchParams({
        state: "open",
        per_page: "100",
    });
    const { data } = await githubRequest(
        `/repos/${owner}/${repo}/issues?${query}`,
        { token },
    );

    return data.find((issue) => !issue.pull_request && issue.title === title);
}

async function ensureIssueLabel(owner, repo, token) {
    const labelPath = `/repos/${owner}/${repo}/labels/${encodeURIComponent(ISSUE_LABEL)}`;
    const existing = await githubRequest(labelPath, {
        token,
        allowedStatuses: [200, 404],
    });

    if (existing.response.status === 200) {
        return;
    }

    await githubRequest(`/repos/${owner}/${repo}/labels`, {
        method: "POST",
        token,
        allowedStatuses: [201],
        body: {
            name: ISSUE_LABEL,
            color: ISSUE_LABEL_COLOR,
            description: ISSUE_LABEL_DESCRIPTION,
        },
    });
}

async function createIssue(owner, repo, token, latestTag, vendoredVersion) {
    const title = `Upstream claude-agent-acp released ${latestTag.name}`;
    const body = [
        "A new upstream tag is available.",
        "",
        `- Upstream: ${UPSTREAM_NAME}`,
        `- Latest tag: ${latestTag.name}`,
        `- Vendored version: ${vendoredVersion}`,
        `- Vendored package: \`vendor/Claude-agent-acp-upstream/package.json\``,
        "",
        "Review and update the vendored upstream package when convenient.",
    ].join("\n");

    await ensureIssueLabel(owner, repo, token);

    const { data } = await githubRequest(`/repos/${owner}/${repo}/issues`, {
        method: "POST",
        token,
        allowedStatuses: [201],
        body: {
            title,
            body,
            labels: [ISSUE_LABEL],
        },
    });

    return data;
}

async function main() {
    const { dryRun } = parseArgs(process.argv.slice(2));
    const vendoredPackageJson = readJsonFile(VENDORED_PACKAGE_JSON_PATH);
    const vendoredSemver = parseSemver(vendoredPackageJson.version);

    if (!vendoredSemver) {
        throw new Error(
            `Vendored package version "${vendoredPackageJson.version}" is not strict semver.`,
        );
    }

    const latestTag = await getLatestStableUpstreamTag();

    if (compareSemver(latestTag.semver, vendoredSemver) <= 0) {
        console.log(
            `Vendored ${UPSTREAM_REPO} is current: ${vendoredPackageJson.version}. Latest upstream tag is ${latestTag.name}.`,
        );
        return;
    }

    if (dryRun) {
        console.log(
            `Dry run: upstream ${latestTag.name} is newer than vendored ${vendoredPackageJson.version}.`,
        );
        return;
    }

    const { owner, repo } = getGitHubRepo();
    const token = getGitHubToken();
    const title = `Upstream claude-agent-acp released ${latestTag.name}`;
    const existingIssue = await findOpenIssueByTitle(owner, repo, title, token);

    if (existingIssue) {
        console.log(`Issue already exists: ${existingIssue.html_url}`);
        return;
    }

    const issue = await createIssue(
        owner,
        repo,
        token,
        latestTag,
        vendoredPackageJson.version,
    );

    console.log(`Created issue: ${issue.html_url}`);
}

await main();
