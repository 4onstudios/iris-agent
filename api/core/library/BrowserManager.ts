import fs from "node:fs";
import { execFileSync } from "node:child_process";

import type { Browser, Page, PuppeteerNode } from "puppeteer-core";

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

const resolveCommandFromPath = (command: string): string | undefined => {
  const resolver = process.platform === "win32" ? "where" : "which";

  try {
    return execFileSync(resolver, [command], {
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

const resolveBrowserExecutablePath = async (
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

  const detectedPath = DEFAULT_BROWSER_EXECUTABLE_PATHS.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (detectedPath) {
    return detectedPath;
  }

  const cachedExecutablePath = await puppeteer.executablePath();
  if (cachedExecutablePath && fs.existsSync(cachedExecutablePath)) {
    return cachedExecutablePath;
  }

  throw new Error(
    "Browser executable not found. Install Chrome/Chromium, run `npm run browser:install`, or set PUPPETEER_EXECUTABLE_PATH, CHROME_EXECUTABLE_PATH, or BROWSER_EXECUTABLE_PATH.",
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
