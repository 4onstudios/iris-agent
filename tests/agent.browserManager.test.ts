import fs from "node:fs";
import * as childProcess from "node:child_process";
import {
  computeExecutablePath,
  detectBrowserPlatform,
} from "@puppeteer/browsers";

jest.mock("node:child_process", () => ({
  execFileSync: jest.fn(),
}));

jest.mock("@puppeteer/browsers", () => ({
  Browser: { CHROME: "chrome" },
  computeExecutablePath: jest.fn(({ cacheDir }) => `${cacheDir}/chrome`),
  detectBrowserPlatform: jest.fn(() => "mac_arm"),
}));

import type { PuppeteerNode } from "puppeteer-core";
import {
  BROWSER_INSTALL_COMMAND,
  getBrowserCacheDirectory,
  resolveBrowserExecutablePath,
} from "../api/core/library/BrowserManager";

const originalEnv = { ...process.env };

const createPuppeteerMock = (
  executablePath: jest.Mock = jest.fn(),
): PuppeteerNode => ({ executablePath }) as unknown as PuppeteerNode;

describe("BrowserManager browser executable resolution", () => {
  beforeEach(() => {
    (computeExecutablePath as jest.Mock).mockImplementation(
      ({ cacheDir }) => `${cacheDir}/chrome`,
    );
    (detectBrowserPlatform as jest.Mock).mockReturnValue("mac_arm");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetAllMocks();
    process.env = { ...originalEnv };
  });

  it("uses configured executable path environment variables first", async () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/configured/chrome";
    jest.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === "/configured/chrome";
    });
    const execFileSync = childProcess.execFileSync as jest.Mock;
    const executablePath = jest.fn();

    await expect(
      resolveBrowserExecutablePath(createPuppeteerMock(executablePath)),
    ).resolves.toBe("/configured/chrome");

    expect(execFileSync).not.toHaveBeenCalled();
    expect(executablePath).not.toHaveBeenCalled();
  });

  it("resolves browsers from PATH before known filesystem candidates", async () => {
    jest.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === "/usr/local/bin/google-chrome";
    });
    (childProcess.execFileSync as jest.Mock).mockReturnValue(
      "/usr/local/bin/google-chrome\n",
    );
    const executablePath = jest.fn();

    await expect(
      resolveBrowserExecutablePath(createPuppeteerMock(executablePath)),
    ).resolves.toBe("/usr/local/bin/google-chrome");

    expect(executablePath).not.toHaveBeenCalled();
  });

  it("detects per-user Windows browser installations", async () => {
    process.env.LOCALAPPDATA = "C:\\Users\\Ada\\AppData\\Local";
    const chromePath =
      "C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    jest.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return candidate === chromePath;
    });
    (childProcess.execFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("not on PATH");
    });
    const executablePath = jest.fn();

    await expect(
      resolveBrowserExecutablePath(createPuppeteerMock(executablePath)),
    ).resolves.toBe(chromePath);

    expect(executablePath).not.toHaveBeenCalled();
  });

  it("uses PUPPETEER_CACHE_DIR when resolving Puppeteer's cached executable", async () => {
    process.env.PUPPETEER_CACHE_DIR = "/custom/puppeteer-cache";
    jest.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate).startsWith("/custom/puppeteer-cache/");
    });
    (childProcess.execFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("not on PATH");
    });
    const executablePath = jest.fn();

    const resolvedPath = await resolveBrowserExecutablePath(
      createPuppeteerMock(executablePath),
    );

    expect(resolvedPath).toContain("/custom/puppeteer-cache/");
    expect(executablePath).not.toHaveBeenCalled();
    expect(getBrowserCacheDirectory()).toBe("/custom/puppeteer-cache");
  });

  it("falls through cache lookup failures to the actionable missing-browser error", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    (childProcess.execFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("not on PATH");
    });

    await expect(
      resolveBrowserExecutablePath(
        createPuppeteerMock(jest.fn().mockRejectedValue(new Error("No cache"))),
      ),
    ).rejects.toThrow(BROWSER_INSTALL_COMMAND);
  });
});
