import cliSpinners from "cli-spinners";

export const startCliSpinner = (label: string): (() => void) => {
  if (!process.stdout.isTTY || process.env.CI) {
    return () => {};
  }

  const { frames, interval } = cliSpinners.dots;
  let frameIndex = 0;
  const render = (): void => {
    process.stdout.write(`\r${frames[frameIndex]} ${label}`);
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
