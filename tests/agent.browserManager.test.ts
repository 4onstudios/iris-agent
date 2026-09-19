const mockLaunch = jest.fn();

jest.mock("puppeteer", () => ({
  __esModule: true,
  default: { launch: mockLaunch },
}));

import BrowserManager from "../api/core/library/BrowserManager";

describe("BrowserManager", () => {
  beforeEach(() => {
    mockLaunch.mockReset();
    BrowserManager.instance = null;
    BrowserManager.initPromise = null;
  });

  it("launches Puppeteer without an executable path", async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const newPage = jest.fn().mockResolvedValue({});
    mockLaunch.mockResolvedValue({ close, newPage });

    const manager = await BrowserManager.getInstance();

    expect(mockLaunch).toHaveBeenCalledWith({ headless: true, args: [] });
    await expect(manager.newPage()).resolves.toEqual({});
  });

  it("passes no-sandbox flags only when explicitly enabled", async () => {
    process.env.BROWSER_NO_SANDBOX = "true";
    mockLaunch.mockResolvedValue({ close: jest.fn(), newPage: jest.fn() });

    await BrowserManager.getInstance();

    expect(mockLaunch).toHaveBeenCalledWith({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    delete process.env.BROWSER_NO_SANDBOX;
  });

  it("resets the singleton when initialization fails", async () => {
    const error = new Error("launch failed");
    mockLaunch.mockRejectedValue(error);

    await expect(BrowserManager.getInstance()).rejects.toBe(error);
    expect(BrowserManager.instance).toBeNull();
    expect(BrowserManager.initPromise).toBeNull();
  });
});
