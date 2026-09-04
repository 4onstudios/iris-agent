//creating a class to manage the browsing activities and how it will be handled

import type { Browser, Page } from "puppeteer";

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
    const { default: puppeteer } = await import("puppeteer");

    const noSandboxArgs =
      process.env.BROWSER_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : [];

    this.browser = await puppeteer.launch({
      headless: true,
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
