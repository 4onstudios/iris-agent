import type { Browser, Page } from "puppeteer";

class BrowserManager {
  static instance: BrowserManager | null = null;
  static initPromise: Promise<void> | null = null;
  browser: Browser | null = null;

  static async getInstance(): Promise<BrowserManager> {
    if (!BrowserManager.initPromise) {
      BrowserManager.initPromise = (async () => {
        BrowserManager.instance = new BrowserManager();
        await BrowserManager.instance.init();
      })().catch((err) => {
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
    if (!this.browser) {
      throw new Error("No Browser instance was found!");
    }
    return this.browser.newPage();
  }

  async close(): Promise<void> {
    if (!this.browser) {
      return;
    }
    try {
      await this.browser.close();
    } catch {
      // The browser may already have been closed by the caller.
    } finally {
      this.browser = null;
      BrowserManager.instance = null;
      BrowserManager.initPromise = null;
    }
  }
}

export default BrowserManager;
