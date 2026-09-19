import { startCliSpinner } from "../api/core/library/cliSpinner";

const originalIsTTY = process.stdout.isTTY;
const originalCI = process.env.CI;

describe("startCliSpinner", () => {
  const write = jest
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    delete process.env.CI;
    write.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  afterAll(() => {
    write.mockRestore();
  });

  it("does not write in non-TTY output", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    const stop = startCliSpinner("Thinking...");

    stop();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write in CI", () => {
    process.env.CI = "true";

    const stop = startCliSpinner("Thinking...");

    stop();
    expect(write).not.toHaveBeenCalled();
  });

  it("renders frames and clears the active line when stopped", () => {
    const stop = startCliSpinner("Thinking...");

    expect(write).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(80);
    expect(write).toHaveBeenCalledTimes(2);

    stop();

    expect(write).toHaveBeenLastCalledWith("\r\x1b[2K");
    jest.advanceTimersByTime(80);
    expect(write).toHaveBeenCalledTimes(3);
  });
});
