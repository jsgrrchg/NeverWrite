const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("npm/")) {
    console.error(
        "The desktop app must be installed with npm. Run `npm ci` from apps/desktop.",
    );
    process.exitCode = 1;
}
