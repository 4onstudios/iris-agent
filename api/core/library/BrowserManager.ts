import fs from "node:fs";
import * as childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  Browser as PuppeteerBrowser,
  computeExecutablePath,
  detectBrowserPlatform,
} from "@puppeteer/browsers";
import type { Browser, Page, PuppeteerNode } from "puppeteer-core";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const BROWSER_EXECUTABLE_ENV_KEYS = [
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_EXECUTABLE_PATH",
  "BROWSER_EXECUTABLE_PATH",
];

const DEFAULT_BROWSER_EXECUTABLE_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
];

const getWindowsLocalBrowserExecutablePaths = (): string[] => {
  const localAppDataCandidates = [
    process.env.LOCALAPPDATA?.trim(),
    process.env.USERPROFILE?.trim()
      ? `${process.env.USERPROFILE.trim()}\\AppData\\Local`
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(localAppDataCandidates)].flatMap((basePath) => [
    `${basePath}\\Google\\Chrome\\Application\\chrome.exe`,
    `${basePath}\\Chromium\\Application\\chrome.exe`,
    `${basePath}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]);
};

const PATH_BROWSER_COMMANDS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium-browser",
  "chromium",
  "chrome",
  "chrome.exe",
  "msedge",
  "microsoft-edge",
  "msedge.exe",
];

export const BROWSER_INSTALL_COMMAND =
  "npx --yes --package @4onstudios/iris-agent@latest iris-agent-install-browser";

export const getBrowserCacheDirectory = (): string =>
  process.env.PUPPETEER_CACHE_DIR?.trim() ||
  path.join(os.homedir(), ".cache", "puppeteer");

const resolveCachedBrowserExecutablePath = (): string | undefined => {
  const platform = detectBrowserPlatform();
  const chromeRevision = PUPPETEER_REVISIONS.chrome;
  if (!platform || !chromeRevision) {
    return undefined;
  }

  try {
    const cachedExecutablePath = computeExecutablePath({
      browser: PuppeteerBrowser.CHROME,
      buildId: chromeRevision,
      cacheDir: getBrowserCacheDirectory(),
      platform,
    });

    return fs.existsSync(cachedExecutablePath)
      ? cachedExecutablePath
      : undefined;
  } catch {
    return undefined;
  }
};

const resolveCommandFromPath = (command: string): string | undefined => {
  const resolver = process.platform === "win32" ? "where" : "which";

  try {
    return childProcess.execFileSync(resolver, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && fs.existsSync(line));
  } catch {
    return undefined;
  }
};

export const resolveBrowserExecutablePath = async (
  puppeteer: PuppeteerNode,
): Promise<string> => {
  for (const key of BROWSER_EXECUTABLE_ENV_KEYS) {
    const configuredPath = process.env[key]?.trim();
    if (configuredPath && fs.existsSync(configuredPath)) {
      return configuredPath;
    }
  }

  for (const command of PATH_BROWSER_COMMANDS) {
    const pathFromCommand = resolveCommandFromPath(command);
    if (pathFromCommand) {
      return pathFromCommand;
    }
  }

  const detectedPath = [
    ...getWindowsLocalBrowserExecutablePaths(),
    ...DEFAULT_BROWSER_EXECUTABLE_PATHS,
  ].find((candidate) => fs.existsSync(candidate));
  if (detectedPath) {
    return detectedPath;
  }

  const cachedExecutablePath = resolveCachedBrowserExecutablePath();
  if (cachedExecutablePath) {
    return cachedExecutablePath;
  }

  try {
    const cachedExecutablePath = await puppeteer.executablePath();
    if (cachedExecutablePath && fs.existsSync(cachedExecutablePath)) {
      return cachedExecutablePath;
    }
  } catch {
    // Fall through to the actionable installation/configuration guidance below.
  }

  throw new Error(
    `Browser executable not found. Install Chrome/Chromium, run \`${BROWSER_INSTALL_COMMAND}\`, or set PUPPETEER_EXECUTABLE_PATH, CHROME_EXECUTABLE_PATH, or BROWSER_EXECUTABLE_PATH.`,
  );
};

class BrowserManager {
  static instance: BrowserManager | null = null;
  static initPromise: Promise<void> | null = null; // shared promise so concurrent callers all await the same init
  browser: Browser | null = null;

  static async getInstance(): Promise<BrowserManager> {
    if (!BrowserManager.initPromise) {
      BrowserManager.initPromise = (async () => {
        BrowserManager.instance = new BrowserManager();
        await BrowserManager.instance.init();
      })().catch((err) => {
        // Reset so the next caller can attempt initialization again
        BrowserManager.initPromise = null;
        BrowserManager.instance = null;
        throw err;
      });
    }
    await BrowserManager.initPromise;
    if (!BrowserManager.instance) {
      throw new Error("Failed to initialize browser manager instance");
    }
    return BrowserManager.instance;
  }

  async init(): Promise<void> {
    // Running in headless mode so no visible browser window is opened.
    // --no-sandbox / --disable-setuid-sandbox disable a major Chromium security
    // boundary and should only be used in constrained environments (e.g. CI/Docker)
    // where the OS sandbox is unavailable. Set BROWSER_NO_SANDBOX=true to opt in.
    const { default: puppeteer } = await import("puppeteer-core");

    const noSandboxArgs =
      process.env.BROWSER_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [];

    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: await resolveBrowserExecutablePath(puppeteer),
      args: noSandboxArgs,
    });
  }

  async newPage(): Promise<Page> {
    //before create a new page we need to verify of the browser instance is available first
    //because  a page cannot be created without no browser instance.
    //if there is none the we return a new page from the browser instance created
    if (!this.browser) {
      throw new Error("No Browser instance was found!");
    }
    return this.browser.newPage();
  }

  //another method of this class to  close the browser instance
  //after browsing activities are complete.
  async close() {
    if (!this.browser) {
      return;
    }
    try {
      await this.browser.close();
    } catch (err) {
      // Ignore errors from browsers that are already closed
    } finally {
      this.browser = null;
      BrowserManager.instance = null;
      BrowserManager.initPromise = null;
    }
  }
}

export default BrowserManager;
