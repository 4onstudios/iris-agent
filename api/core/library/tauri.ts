/**
 * Tauri integration utilities.
 */
import { tauriImport } from "./tauriImport";

type FileSystemOptions = {
  recursive?: boolean;
};

type DialogOpenOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  recursive?: boolean;
  canCreateDirectories?: boolean;
  fileAccessMode?: "copy" | "scoped";
};

type FileSystemApi = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  readDir: (path: string, options?: FileSystemOptions) => Promise<any>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string, options?: FileSystemOptions) => Promise<any>;
  remove: (path: string, options?: FileSystemOptions) => Promise<any>;
  rename: (oldPath: string, newPath: string) => Promise<any>;
};

type DialogApi = {
  open: (options?: DialogOpenOptions) => Promise<any>;
  save: (options?: Record<string, unknown>) => Promise<any>;
  message: (message: string, options?: Record<string, unknown>) => Promise<any>;
  confirm: (message: string, options?: Record<string, unknown>) => Promise<any>;
};

type ShellApi = {
  open: (url: string) => Promise<any>;
};

type ClipboardApi = {
  writeText: (text: unknown) => Promise<boolean>;
  readText: () => Promise<string>;
};

type NotificationsApi = {
  send: (title: string, body?: string) => Promise<any>;
  requestPermission: () => Promise<"granted" | "denied" | NotificationPermission>;
};

export const isTauri = () => {
  if (typeof window === "undefined") {
    return false;
  }

  // In Node.js backend service, Tauri is never available
  if (typeof window === "undefined") {
    return false;
  }

  const hostname = window.location?.hostname || "";
  const protocol = window.location?.protocol || "";
  const userAgent = window.navigator?.userAgent || "";

  return (
    (window as any).__TAURI__ !== undefined ||
    (window as any).__TAURI_IPC__ !== undefined ||
    hostname === "tauri.localhost" ||
    hostname.endsWith(".tauri.localhost") ||
    protocol === "tauri:" ||
    /\bTauri\b/i.test(userAgent)
  );
};

/**
 * File system operations.
 */
export const fileSystem: FileSystemApi = {
  readFile: async (path): Promise<string> => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { readTextFile } = await tauriImport("@tauri-apps/api/fs");
    return await readTextFile(path);
  },

  writeFile: async (path, content): Promise<void> => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { writeTextFile } = await tauriImport("@tauri-apps/api/fs");
    return await writeTextFile(path, content);
  },

  readDir: async (path: string, options: FileSystemOptions = {}) => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { readDir } = await tauriImport("@tauri-apps/api/fs");
    return await readDir(path, options);
  },

  exists: async (path: string) => {
    if (!isTauri()) return false;
    const { exists } = await tauriImport("@tauri-apps/api/fs");
    return await exists(path);
  },

  mkdir: async (path: string, options: FileSystemOptions = {}) => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { mkdir } = await tauriImport("@tauri-apps/api/fs");
    return await mkdir(path, options);
  },

  remove: async (path: string, options: FileSystemOptions = {}) => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { remove } = await tauriImport("@tauri-apps/api/fs");
    return await remove(path, options);
  },

  rename: async (oldPath: string, newPath: string) => {
    if (!isTauri()) {
      throw new Error("File system operations only available in desktop app");
    }
    const { rename } = await tauriImport("@tauri-apps/api/fs");
    return await rename(oldPath, newPath);
  },
};

/**
 * Dialog operations.
 */
export const dialog: DialogApi = {
  open: async (options = {}) => {
    if (!isTauri()) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        if (options.directory) {
          input.webkitdirectory = true;
          input.setAttribute("directory", "");
        }
        input.multiple = options.multiple || false;
        input.onchange = (e) => {
          const target = e.target as HTMLInputElement | null;
          const files = Array.from(target?.files || []);
          resolve(files.length === 1 && !options.multiple ? files[0] : files);
        };
        input.click();
      });
    }
    const { open } = await tauriImport("@tauri-apps/api/dialog");
    return await open(options);
  },

  save: async (options = {}) => {
    if (!isTauri()) {
      throw new Error("Save dialog only available in desktop app");
    }
    const { save } = await tauriImport("@tauri-apps/api/dialog");
    return await save(options);
  },

  message: async (message, options = {}) => {
    if (!isTauri()) {
      alert(message);
      return;
    }
    const { message: showMessage } = await tauriImport(
      "@tauri-apps/api/dialog",
    );
    return await showMessage(message, options);
  },

  confirm: async (message, options = {}) => {
    if (!isTauri()) {
      return confirm(message);
    }
    const { confirm: showConfirm } = await tauriImport(
      "@tauri-apps/api/dialog",
    );
    return await showConfirm(message, options);
  },
};

export const tauriPath = {
  homeDir: async () => {
    if (!isTauri()) {
      return null;
    }

    const { homeDir } = await tauriImport("@tauri-apps/api/path");
    return await homeDir();
  },
};

/**
 * Shell operations.
 */
export const shell: ShellApi = {
  open: async (url) => {
    if (!isTauri()) {
      window.open(url, "_blank");
      return;
    }
    const { open } = await tauriImport("@tauri-apps/api/shell");
    return await open(url);
  },
};

/**
 * Clipboard operations.
 */
export const clipboard: ClipboardApi = {
  writeText: async (text) => {
    const value = typeof text === "string" ? text : String(text ?? "");

    // 1) Prefer native Tauri clipboard in desktop builds.
    if (isTauri()) {
      try {
        const { writeText } = await tauriImport("@tauri-apps/api/clipboard");
        await writeText(value);
        return true;
      } catch (error) {
        console.warn("Tauri clipboard write failed, trying web fallback", error);
      }
    }

    // 2) Standard async clipboard API.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (error) {
      console.warn("navigator.clipboard.writeText failed", error);
    }

    throw new Error("Clipboard write is unavailable in this environment");
  },

  readText: async () => {
    if (!isTauri()) {
      if (navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return "";
    }
    const { readText } = await tauriImport("@tauri-apps/api/clipboard");
    return await readText();
  },
};

/**
 * Notifications.
 */
export const notifications: NotificationsApi = {
  send: async (title, body) => {
    if (!isTauri()) {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
      }
      return;
    }
    const { sendNotification } = await tauriImport(
      "@tauri-apps/api/notification",
    );
    return await sendNotification({ title, body });
  },

  requestPermission: async () => {
    if (!isTauri()) {
      if ("Notification" in window) {
        return await Notification.requestPermission();
      }
      return "denied";
    }
    const { isPermissionGranted, requestPermission } = await tauriImport(
      "@tauri-apps/api/notification",
    );
    let permission = await isPermissionGranted();
    if (!permission) {
      permission = await requestPermission();
    }
    return permission ? "granted" : "denied";
  },
};

export default {
  isTauri,
  fileSystem,
  dialog,
  shell,
  clipboard,
  notifications,
};
