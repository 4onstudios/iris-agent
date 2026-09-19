import {
  isCliSpinnerEnabled,
  startCliSpinner,
} from "../api/core/library/cliSpinner";

const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);
const originalColumnsDescriptor = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);
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
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 80,
    });
    delete process.env.CI;
    write.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTYDescriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    if (originalColumnsDescriptor) {
      Object.defineProperty(process.stdout, "columns", originalColumnsDescriptor);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
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

  it("truncates labels to the terminal width", () => {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 20,
    });

    const stop = startCliSpinner("Running a very long MCP tool name...");

    expect(write.mock.calls[0][0].slice(1)).toHaveLength(20);
    stop();
  });
});

describe("isCliSpinnerEnabled", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    delete process.env.CI;
  });

  afterEach(() => {
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTYDescriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  it("is true for an interactive terminal outside CI", () => {
    expect(isCliSpinnerEnabled()).toBe(true);
  });

  it("is false when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    expect(isCliSpinnerEnabled()).toBe(false);
  });

  it("is false when CI is set", () => {
    process.env.CI = "true";

    expect(isCliSpinnerEnabled()).toBe(false);
  });
});
