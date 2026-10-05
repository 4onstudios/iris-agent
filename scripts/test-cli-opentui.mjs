import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import {
  chatRendererConfig,
  mountOpenTuiChatUi,
} from "../dist/api/core/library/cliOpenTui.js";

const signalListeners = process.listenerCount("SIGINT");
const test = await createTestRenderer({
  ...chatRendererConfig,
  width: 100,
  height: 28,
  kittyKeyboard: true,
  exitOnCtrlC: false,
  consoleMode: "disabled",
});
assert.equal(test.renderer.screenMode, "alternate-screen");
assert.equal(test.renderer.externalOutputMode, "passthrough");
const ui = mountOpenTuiChatUi(test.renderer, {
  modelId: "test/model",
  workspaceRoot: "/workspace/test",
});
if (process.argv.includes("--check-sighup")) {
  try {
    const waiting = ui.readInput();
    process.emit("SIGHUP");
    assert.equal(process.exitCode, 129);
    assert.equal(await waiting, null);
    assert.equal(process.listenerCount("SIGINT"), signalListeners);
  } finally {
    ui.dispose();
  }
  console.log("OpenTUI SIGHUP handling passed.");
} else {
  try {
    const input = ui.readInput();
    await test.mockInput.typeText("first");
    test.mockInput.pressEnter({ shift: true });
    await test.mockInput.typeText("  second");
    test.mockInput.pressKey("j", { ctrl: true });
    await test.mockInput.typeText("third");
    test.mockInput.pressEnter();
    assert.equal(await input, "first\n  second\nthird");

    let cancelled = 0;
    ui.beginTurn("first\n  second\nthird", () => cancelled++);
    ui.appendText("# Streaming response\n\nHello **world**.");
    ui.toolCall("readFile", "tool-1");
    ui.toolResult("in_progress", "tool-1");
    ui.toolResult("completed", "tool-1");
    ui.toolCall("executeCommand", "tool-2");
    ui.toolResult("pending_confirmation", "tool-2");
    ui.appendText("\nReady to continue.");
    // The real parser worker needs event-loop time, unlike a mocked Tree-sitter client.
    let frame = "";
    const deadline = Date.now() + 5_000;
    do {
      await test.renderOnce();
      frame = test.captureCharFrame();
      if (frame.includes("Streaming response") && frame.includes("Hello world"))
        break;
      assert.ok(
        Date.now() < deadline,
        "Markdown did not render before the deadline",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
    assert.match(frame, /Streaming response/);
    assert.match(frame, /Hello world/);
    assert.match(frame, /readFile.*completed/);
    assert.match(frame, /executeCommand.*approval required/);

    // Editing remains possible during a response, but Enter cannot start a second turn.
    await test.mockInput.pasteBracketedText("draft\n  😀 next");
    test.mockInput.pressEnter();
    test.mockInput.pressEscape();
    assert.equal(cancelled, 1);
    ui.finishTurn("cancelled");
    const draft = ui.readInput();
    test.mockInput.pressEnter();
    assert.equal(await draft, "draft\n  😀 next");

    test.resize(40, 12);
    await test.renderOnce();
    assert.match(test.captureCharFrame(), /Enter send/);
    ui.dispose();
    assert.equal(process.listenerCount("SIGINT"), signalListeners);
  } finally {
    ui.dispose();
  }
  const sighupCheck = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--check-sighup"],
    { encoding: "utf8" },
  );
  assert.equal(
    sighupCheck.status,
    129,
    `Expected the SIGHUP test process to exit 129.\n${sighupCheck.stderr || ""}`,
  );
  console.log("OpenTUI native chat checks passed.");
}
