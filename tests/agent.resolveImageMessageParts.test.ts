import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveImageMessageParts } from "../api/agent";

describe("resolveImageMessageParts", () => {
  let workspaceRoot: string;
  let externalRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-image-workspace-"));
    externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-image-external-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  });

  it("reads an image inside the workspace", async () => {
    const imagePath = path.join(workspaceRoot, "chart.png");
    await fs.writeFile(imagePath, Buffer.from("fake-png-data"));

    const parts = await resolveImageMessageParts(
      [{ name: "chart.png", path: "chart.png", type: "image/png" }],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect((parts[0] as any).image).toMatch(/^data:image\/png;base64,/);
  });

  it("reads an image outside the workspace using an absolute path when explicitly allowed", async () => {
    const imagePath = path.join(externalRoot, "outside.png");
    await fs.writeFile(imagePath, Buffer.from("external-png-data"));

    const parts = await resolveImageMessageParts(
      [{ name: "outside.png", path: imagePath, type: "image/png" }],
      workspaceRoot,
      false,
      true,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("skips out-of-workspace absolute paths by default", async () => {
    const imagePath = path.join(externalRoot, "outside.png");
    await fs.writeFile(imagePath, Buffer.from("external-png-data"));

    const parts = await resolveImageMessageParts(
      [{ name: "outside.png", path: imagePath, type: "image/png" }],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(0);
  });

  it("skips images larger than the 5MB limit", async () => {
    const imagePath = path.join(workspaceRoot, "huge.png");
    await fs.writeFile(imagePath, Buffer.alloc(5 * 1024 * 1024 + 1));

    const parts = await resolveImageMessageParts(
      [{ name: "huge.png", path: "huge.png", type: "image/png" }],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(0);
  });

  it("blocks relative paths that escape the workspace", async () => {
    const secretPath = path.join(externalRoot, "secret.png");
    await fs.writeFile(secretPath, Buffer.from("secret-png-data"));

    const relativeEscape = path.relative(workspaceRoot, secretPath);
    const parts = await resolveImageMessageParts(
      [{ name: "secret.png", path: relativeEscape, type: "image/png" }],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(0);
  });

  it("passes through client-provided data URLs unchanged", async () => {
    const dataUrl = "data:image/png;base64,ZmFrZQ==";

    const parts = await resolveImageMessageParts(
      [{ name: "inline.png", path: "inline.png", type: "image/png", imageDataUrl: dataUrl }],
      workspaceRoot,
      false,
    );

    expect(parts).toEqual([{ type: "image", image: dataUrl, mediaType: "image/png" }]);
  });

  it("passes through HTTPS image URLs unchanged", async () => {
    const httpsUrl = "https://example.com/image.png";

    const parts = await resolveImageMessageParts(
      [{ name: "remote.png", path: httpsUrl, type: "image/png" }],
      workspaceRoot,
      false,
    );

    expect(parts).toEqual([{ type: "image", image: httpsUrl, mediaType: "image/png" }]);
  });

  it("skips blob URLs and unreadable paths", async () => {
    const parts = await resolveImageMessageParts(
      [
        { name: "blob.png", path: "blob:abc123", type: "image/png" },
        { name: "missing.png", path: "missing.png", type: "image/png" },
      ],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(0);
  });

  it("skips file-system reads in web workspace mode", async () => {
    const imagePath = path.join(workspaceRoot, "web.png");
    await fs.writeFile(imagePath, Buffer.from("web-png-data"));

    const parts = await resolveImageMessageParts(
      [{ name: "web.png", path: "web.png", type: "image/png" }],
      workspaceRoot,
      true,
    );

    expect(parts).toHaveLength(0);
  });

  it("enforces MAX_IMAGES_PER_REQUEST limit, accepting only the first image when multiple are provided", async () => {
    const image1Path = path.join(workspaceRoot, "first.png");
    const image2Path = path.join(workspaceRoot, "second.png");
    const firstImageData = Buffer.from("first-unique-data-12345");
    const secondImageData = Buffer.from("second-unique-data-67890");
    await fs.writeFile(image1Path, firstImageData);
    await fs.writeFile(image2Path, secondImageData);

    const parts = await resolveImageMessageParts(
      [
        { name: "first.png", path: "first.png", type: "image/png" },
        { name: "second.png", path: "second.png", type: "image/png" },
      ],
      workspaceRoot,
      false,
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/png" });

    // Verify it's the first image by checking the data URL encodes the first image's data
    const dataUrl = (parts[0] as any).image as string;
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
    const decodedData = Buffer.from(base64Data, "base64").toString();
    expect(decodedData).toBe("first-unique-data-12345");
  });
});
