import { claudeHostTarget, prepareClaudeRuntime } from "./claude-runtime.mjs";

let target = claudeHostTarget();
let force = false;
for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === "--target" && process.argv[index + 1]) target = process.argv[++index];
    else if (arg === "--force") force = true;
    else throw new Error(`Unknown argument: ${arg}. Use --target <target> and/or --force.`);
}
console.log(await prepareClaudeRuntime(target, { force }));
