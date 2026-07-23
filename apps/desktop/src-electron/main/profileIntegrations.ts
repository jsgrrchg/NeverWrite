export interface ProfileIntegrationCapabilities {
    enableProductionDeepLinks: boolean;
    enableWebClipperServer: boolean;
}

export function installProfileIntegrations(
    capabilities: ProfileIntegrationCapabilities,
    installers: {
        installProductionDeepLinks: () => void;
        installWebClipperServer: () => void;
    },
) {
    if (capabilities.enableWebClipperServer) {
        installers.installWebClipperServer();
    }
    if (capabilities.enableProductionDeepLinks) {
        installers.installProductionDeepLinks();
    }
}
