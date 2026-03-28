type DeferredUnlisten = () => void;

export function resolveDeferredUnlisten(
    registration: PromiseLike<DeferredUnlisten> | DeferredUnlisten,
    options: {
        isDisposed: () => boolean;
        onResolved: (cleanup: DeferredUnlisten) => void;
        onError?: (error: unknown) => void;
    },
) {
    void Promise.resolve(registration)
        .then((cleanup) => {
            if (typeof cleanup !== "function") {
                return;
            }

            if (options.isDisposed()) {
                void cleanup();
                return;
            }

            options.onResolved(cleanup);
        })
        .catch((error) => {
            options.onError?.(error);
        });
}
