#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import { Browser, detectBrowserPlatform, install } from "@puppeteer/browsers";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const chromeRevision = PUPPETEER_REVISIONS.chrome;
const cacheDir =
  process.env.PUPPETEER_CACHE_DIR?.trim() ||
  path.join(os.homedir(), ".cache", "puppeteer");
const platform = detectBrowserPlatform();

if (!chromeRevision) {
  throw new Error("Unable to determine the Chrome revision for puppeteer-core.");
}

if (!platform) {
  throw new Error("Unable to determine a supported browser platform.");
}

const installedBrowser = await install({
  browser: Browser.CHROME,
  buildId: chromeRevision,
  cacheDir,
  platform,
});

console.log(`Installed Chrome ${chromeRevision} at ${installedBrowser.executablePath}`);
