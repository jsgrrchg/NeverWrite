import { preparePiRuntime } from "./pi-runtime.mjs";

let force = false;
for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--force") force = true;
    else throw new Error(`Unknown argument: ${process.argv[index]}. Use --force.`);
}

console.log(await preparePiRuntime({ force }));
