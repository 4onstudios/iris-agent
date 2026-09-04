/**
 * Stub implementation for backend service
 * Tauri modules are not available in Node.js backend
 */

export const tauriImport = (moduleName: string): Promise<any> => {
  return Promise.reject(
    new Error(`Tauri module '${moduleName}' not available in backend service`)
  );
};
