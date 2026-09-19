import cliSpinners from "cli-spinners";

const DEFAULT_TERMINAL_WIDTH = 80;

// Shared gate so callers can decide whether to print a static fallback
// message when the animated spinner itself is a no-op (redirected/CI output).
export const isCliSpinnerEnabled = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.CI;

const truncateLabel = (label: string): string => {
  const terminalWidth =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : DEFAULT_TERMINAL_WIDTH;
  const availableLabelWidth = Math.max(1, terminalWidth - 2);

  if (label.length <= availableLabelWidth) {
    return label;
  }

  if (availableLabelWidth === 1) {
    return "…";
  }

  return `${label.slice(0, availableLabelWidth - 1)}…`;
};

export const startCliSpinner = (label: string): (() => void) => {
  if (!isCliSpinnerEnabled()) {
    return () => {};
  }

  const { frames, interval } = cliSpinners.dots;
  const displayedLabel = truncateLabel(label);
  let frameIndex = 0;
  const render = (): void => {
    process.stdout.write(`\r${frames[frameIndex]} ${displayedLabel}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };

  render();
  const timer = setInterval(render, interval);
  timer.unref();

  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  };
};
