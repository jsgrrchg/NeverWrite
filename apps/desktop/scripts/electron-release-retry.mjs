const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createCommandExitError(command, args, code, signal) {
    const error = new Error(
        signal
            ? `${command} ${args.join(" ")} terminated with ${signal}`
            : `${command} ${args.join(" ")} exited with ${code}`,
    );
    error.exitCode = code;
    error.signal = signal;
    return error;
}

export function electronBuilderRetryAttempts(publishMode) {
    return publishMode === "never" ? DEFAULT_ATTEMPTS : 1;
}

export async function runWithRetry(
    operation,
    {
        attempts = DEFAULT_ATTEMPTS,
        retryDelayMs = DEFAULT_RETRY_DELAY_MS,
        waitForRetry = wait,
        onRetry = () => {},
    } = {},
) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await operation();
            return;
        } catch (error) {
            if (error?.signal || attempt === attempts) {
                throw error;
            }

            onRetry({ attempt, attempts, retryDelayMs, error });
            await waitForRetry(retryDelayMs);
        }
    }
}
