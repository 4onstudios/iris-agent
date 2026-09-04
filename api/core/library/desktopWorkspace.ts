// The HTTP service has no desktop webview state. Integrating clients must pass
// the workspace root explicitly with each agent request.
export const getDesktopWorkspacePath = (): string | null => null;
