import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const chromeRevision = PUPPETEER_REVISIONS.chrome;
const cacheDir =
  process.env.PUPPETEER_CACHE_DIR?.trim() ||
  path.join(os.homedir(), ".cache", "puppeteer");

if (!chromeRevision) {
  throw new Error("Unable to determine the Chrome revision for puppeteer-core.");
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "@puppeteer/browsers",
    "install",
    `chrome@${chromeRevision}`,
    "--path",
    cacheDir,
  ],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
