import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import readPdfTool, {
  readPdf,
  type ReadPdfParams,
  type ReadPdfResult,
} from "../api/core/agent/tools/readPdf.js";

let directory: string;
let filePath: string;

function success(result: ReadPdfResult): asserts result is Extract<ReadPdfResult, { success: true }> {
  assert.equal(result.success, true, JSON.stringify(result));
}

before(async () => {
  directory = await fs.mkdtemp(path.join(process.cwd(), "pdf-test-"));
  filePath = path.join(directory, "sample report.pdf");
  const doc = await PDFDocument.create();
  doc.setTitle("Agent PDF fixture");
  doc.setAuthor("Test author");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    ["Agent PDF test", "Revenue: 1200 USD", "Second line stays separate."],
    ["Growth: 25%", "C++ [agent].* (guide)", "revenue REVENUE Revenue"],
    Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: alpha beta revenue gamma delta ${"x".repeat(20)}`),
    [],
  ];
  const pages = lines.map((pageLines) => {
    const page = doc.addPage([612, 792]);
    pageLines.forEach((line, i) => page.drawText(line, { x: 40, y: 750 - i * 20, size: 10, font }));
    return page;
  });
  // Non-text graphics deliberately have no searchable text layer.
  pages[3]!.drawRectangle({ x: 40, y: 40, width: 200, height: 200 });
  const outline = doc.context.obj({ Type: "Outlines", Count: 2 });
  const outlineRef = doc.context.register(outline);
  const first = doc.context.obj({ Title: PDFString.of("Overview"), Parent: outlineRef, Dest: [pages[0]!.ref, PDFName.of("Fit")] });
  const second = doc.context.obj({ Title: PDFString.of("Details"), Parent: outlineRef, Dest: [pages[1]!.ref, PDFName.of("Fit")] });
  const firstRef = doc.context.register(first);
  const secondRef = doc.context.register(second);
  first.set(PDFName.of("Next"), secondRef);
  second.set(PDFName.of("Prev"), firstRef);
  outline.set(PDFName.of("First"), firstRef);
  outline.set(PDFName.of("Last"), secondRef);
  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
  await fs.writeFile(filePath, await doc.save());
});

after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test("matches the provided tool interface and reads real PDF page text", async () => {
  assert.equal(readPdfTool.execute, readPdf);
  assert.equal(readPdfTool.parameters.parse({ filePath }).action, "read");
  const result = await readPdfTool.execute({ filePath });
  success(result);
  assert.equal(result.action, "read");
  if (result.action !== "read") return;
  assert.equal(result.totalPages, 4);
  assert.match(result.pages[0]!.text, /Revenue: 1200 USD\nSecond line stays separate\./);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.pagesWithoutText, [4]);
  assert.match(result.warnings[0]!, /blank or image-only/);
  assert.equal(result.pages[3]!.hasExtractableText, false);
});

test("resolves relative paths and respects inclusive page ranges", async () => {
  const result = await readPdf({ filePath: path.basename(filePath), cwd: directory, startPage: 2, endPage: 2 });
  success(result);
  assert.equal(result.filePath, filePath);
  if (result.action !== "read") assert.fail("expected read");
  assert.deepEqual(result.pages.map(page => page.pageNumber), [2]);
  assert.match(result.pages[0]!.text, /^Growth: 25%/);
  assert.equal(result.nextRequest, null);
});

test("info returns metadata and resolved bookmarks without page extraction", async () => {
  const result = await readPdf({ filePath, action: "info" });
  success(result);
  if (result.action !== "info") assert.fail("expected info");
  assert.equal(result.metadata.Title, "Agent PDF fixture");
  assert.deepEqual(result.outline, [
    { title: "Overview", depth: 0, pageNumber: 1 },
    { title: "Details", depth: 0, pageNumber: 2 },
  ]);
});

test("text continuation reconstructs every page exactly without omissions or duplicates", async () => {
  const full = await readPdf({ filePath, maxChars: 100_000 });
  success(full);
  if (full.action !== "read") assert.fail("expected read");
  const collected = new Map<number, string>();
  let request: ReadPdfParams | null = { filePath, maxChars: 100, maxPages: 1 };
  let calls = 0;
  while (request) {
    assert.ok(++calls < 100, "continuation must terminate");
    const result = await readPdf(request);
    success(result);
    if (result.action !== "read") assert.fail("expected read");
    assert.ok(result.returnedCharacters <= 100);
    for (const page of result.pages) {
      const prior = collected.get(page.pageNumber) ?? "";
      assert.equal(page.startOffset, prior.length);
      collected.set(page.pageNumber, prior + page.text);
    }
    request = result.nextRequest;
  }
  assert.ok(calls > 4);
  for (const page of full.pages) assert.equal(collected.get(page.pageNumber), page.text);
});

test("search treats regex characters literally and returns citation page numbers", async () => {
  const result = await readPdf({ filePath, action: "search", query: "C++ [agent].* (guide)" });
  success(result);
  if (result.action !== "search") assert.fail("expected search");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.pageNumber, 2);
  assert.match(result.matches[0]!.snippet, /C\+\+ \[agent\]/);
});

test("case sensitivity and search continuation preserve every match exactly once", async () => {
  const insensitive = await readPdf({ filePath, action: "search", query: "revenue", maxMatches: 100, maxChars: 100_000 });
  const sensitive = await readPdf({ filePath, action: "search", query: "revenue", caseSensitive: true, maxMatches: 100, maxChars: 100_000 });
  success(insensitive); success(sensitive);
  if (insensitive.action !== "search" || sensitive.action !== "search") assert.fail("expected search");
  assert.equal(insensitive.matches.length, 34);
  assert.equal(sensitive.matches.length, 31);
  const found: string[] = [];
  let request: ReadPdfParams | null = { filePath, action: "search", query: "revenue", maxMatches: 2, maxChars: 100, maxPages: 1 };
  let calls = 0;
  while (request) {
    assert.ok(++calls < 100);
    const result = await readPdf(request);
    success(result);
    if (result.action !== "search") assert.fail("expected search");
    assert.ok(result.matches.length <= 2);
    assert.ok(result.returnedCharacters <= 100);
    found.push(...result.matches.map(match => `${match.pageNumber}:${match.offset}`));
    request = result.nextRequest;
  }
  assert.deepEqual(found, insensitive.matches.map(match => `${match.pageNumber}:${match.offset}`));
});

test("empty search batches still provide continuation until the range is examined", async () => {
  const first = await readPdf({ filePath, action: "search", query: "does not exist", maxPages: 1 });
  success(first);
  if (first.action !== "search") assert.fail("expected search");
  assert.equal(first.matches.length, 0);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextRequest!.startPage, 2);
});

test("validates direct calls and reports missing, non-PDF, directory and range errors", async () => {
  const invalid = path.join(directory, "not.pdf");
  await fs.writeFile(invalid, "plain text, not a PDF");
  const cases: Array<[ReadPdfParams, string]> = [
    [{ filePath: "" }, "INVALID_INPUT"],
    [{ filePath, startPage: 0 }, "INVALID_INPUT"],
    [{ filePath, startPage: 2, endPage: 1 }, "INVALID_INPUT"],
    [{ filePath, action: "search" }, "INVALID_INPUT"],
    [{ filePath, query: "revenue" }, "INVALID_INPUT"],
    [{ filePath: "https://example.com/report.pdf" }, "INVALID_INPUT"],
    [{ filePath: path.join(directory, "missing.pdf") }, "FILE_NOT_FOUND"],
    [{ filePath: directory }, "NOT_A_FILE"],
    [{ filePath: invalid }, "INVALID_PDF"],
    [{ filePath, endPage: 5 }, "PAGE_OUT_OF_RANGE"],
    [{ filePath, startOffset: 100_000 }, "OFFSET_OUT_OF_RANGE"],
  ];
  for (const [input, code] of cases) {
    const result = await readPdf(input);
    assert.equal(result.success, false, JSON.stringify(input));
    if (result.success) assert.fail("expected error");
    assert.equal(result.code, code);
  }
});

test("rejects damaged and oversized PDFs", async () => {
  const damaged = path.join(directory, "damaged.pdf");
  await fs.writeFile(damaged, "%PDF-1.7\ninvalid bytes\n%%EOF");
  const result = await readPdf({ filePath: damaged });
  assert.equal(result.success, false);
  if (result.success) assert.fail("expected error");
  assert.equal(result.code, "INVALID_PDF");
  const big = path.join(directory, "big.pdf");
  const handle = await fs.open(big, "w");
  await handle.truncate(50 * 1024 * 1024 + 1);
  await handle.close();
  const oversized = await readPdf({ filePath: big });
  assert.equal(oversized.success, false);
  if (oversized.success) assert.fail("expected error");
  assert.equal(oversized.code, "FILE_TOO_LARGE");
});

test("rejects stale continuation after file contents change", async () => {
  const copy = path.join(directory, "changing.pdf");
  await fs.copyFile(filePath, copy);
  const first = await readPdf({ filePath: copy, maxChars: 100 });
  success(first);
  if (first.action !== "read") assert.fail("expected read");
  assert.ok(first.nextRequest);
  await fs.appendFile(copy, "\n% changed\n");
  const resumed = await readPdf(first.nextRequest);
  assert.equal(resumed.success, false);
  if (resumed.success) assert.fail("expected error");
  assert.equal(resumed.code, "DOCUMENT_CHANGED");
});

test("supports agent cancellation and does not echo passwords in continuations", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await readPdf({ filePath }, { abortSignal: controller.signal });
  assert.equal(cancelled.success, false);
  if (cancelled.success) assert.fail("expected error");
  assert.equal(cancelled.code, "ABORTED");
  const result = await readPdf({ filePath, password: "private-secret", maxChars: 100 });
  success(result);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});

test("encrypted PDFs require the right password and recover after failed attempts", async () => {
  const encrypted = fileURLToPath(new URL("./fixtures/encrypted.pdf", import.meta.url));
  const missing = await readPdf({ filePath: encrypted });
  assert.equal(missing.success, false);
  if (missing.success) assert.fail("expected password error");
  assert.equal(missing.code, "PASSWORD_REQUIRED");
  const wrong = await readPdf({ filePath: encrypted, password: "wrong-secret" });
  assert.equal(wrong.success, false);
  if (wrong.success) assert.fail("expected password error");
  assert.equal(wrong.code, "INCORRECT_PASSWORD");
  assert.equal(JSON.stringify(wrong).includes("wrong-secret"), false);
  const opened = await readPdf({ filePath: encrypted, password: "test-password" });
  success(opened);
  if (opened.action !== "read") assert.fail("expected read");
  assert.match(opened.pages[0]!.text, /Encrypted fixture text/);
});
