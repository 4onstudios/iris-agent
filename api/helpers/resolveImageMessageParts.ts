import fs from "fs/promises";
import path from "path";

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

const MAX_IMAGE_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 1;

type ImageContextFile = Record<string, any>;

export type ResolvedImageMessagePart = {
  type: "image";
  image: string;
  mediaType?: string;
};

const isPathWithin = (basePath: string, targetPath: string): boolean => {
  const relative = path.relative(basePath, targetPath);
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
};

const resolveImageMediaType = (file: ImageContextFile): string | undefined => {
  const rawType =
    typeof file?.type === "string" ? file.type.trim().toLowerCase() : "";
  if (rawType.startsWith("image/")) {
    return rawType;
  }

  const ext =
    typeof file?.name === "string"
      ? file.name.split(".").pop()?.toLowerCase() || ""
      : "";
  return IMAGE_EXT_TO_MIME[ext] || undefined;
};

export const isLikelyImageFile = (file: ImageContextFile): boolean => {
  const mediaType = resolveImageMediaType(file);
  if (mediaType) {
    return true;
  }

  const pathValue =
    typeof file?.path === "string" ? file.path.toLowerCase() : "";
  return /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/.test(pathValue);
};

const toDataUrlFromBuffer = (bytes: Buffer, mediaType: string): string =>
  `data:${mediaType};base64,${bytes.toString("base64")}`;

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err === null || err === undefined) {
    return String(err);
  }
  return String(err);
};

export const resolveImageMessageParts = async (
  filesInContext: ImageContextFile[],
  workspacePath: string,
  isWebWorkspace: boolean,
  allowOutOfWorkspace = false,
): Promise<ResolvedImageMessagePart[]> => {
  const parts: ResolvedImageMessagePart[] = [];
  const resolvedWorkspace = path.resolve(workspacePath);
  const realWorkspace = await fs
    .realpath(resolvedWorkspace)
    .catch(() => resolvedWorkspace);
  let imagesIncluded = 0;

  for (const file of filesInContext) {
    if (!isLikelyImageFile(file)) {
      continue;
    }

    if (imagesIncluded >= MAX_IMAGES_PER_REQUEST) {
      console.warn("Skipping image: reached maximum images per request limit");
      continue;
    }

    const mediaType = resolveImageMediaType(file) || "image/png";
    const encodedFromClient =
      typeof file?.imageDataUrl === "string" ? file.imageDataUrl.trim() : "";
    if (encodedFromClient.startsWith("data:image/")) {
      parts.push({
        type: "image",
        image: encodedFromClient,
        mediaType,
      });
      imagesIncluded++;
      continue;
    }

    const directUrlCandidates = [file?.imageUrl, file?.previewUrl, file?.path]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .map((value) => value.trim());
    const httpsUrl = directUrlCandidates.find((value) =>
      /^https?:\/\//i.test(value),
    );
    if (httpsUrl) {
      parts.push({
        type: "image",
        image: httpsUrl,
        mediaType,
      });
      imagesIncluded++;
      continue;
    }

    if (isWebWorkspace) {
      continue;
    }

    const filePathValue =
      typeof file?.path === "string" && file.path.trim().length > 0
        ? file.path.trim()
        : "";
    if (!filePathValue || /^blob:/i.test(filePathValue)) {
      continue;
    }

    const absolutePath = path.isAbsolute(filePathValue)
      ? path.resolve(filePathValue)
      : path.resolve(path.join(resolvedWorkspace, filePathValue));

    if (!path.isAbsolute(filePathValue)) {
      if (!isPathWithin(resolvedWorkspace, absolutePath)) {
        console.warn(
          "Skipping path-traversing relative image path:",
          filePathValue,
        );
        continue;
      }
    }

    try {
      let readablePath = absolutePath;
      if (!allowOutOfWorkspace) {
        const realAbsolutePath = await fs.realpath(absolutePath);
        if (!isPathWithin(realWorkspace, realAbsolutePath)) {
          console.warn(
            "Skipping out-of-workspace image path:",
            filePathValue,
          );
          continue;
        }
        readablePath = realAbsolutePath;
      }

      const stats = await fs.stat(readablePath);
      if (!stats.isFile()) {
        continue;
      }
      if (stats.size > MAX_IMAGE_FILE_SIZE_BYTES) {
        console.warn(
          "Skipping oversized image:",
          filePathValue,
          `${stats.size} bytes exceeds limit of ${MAX_IMAGE_FILE_SIZE_BYTES} bytes`,
        );
        continue;
      }
      const bytes = await fs.readFile(readablePath);
      parts.push({
        type: "image",
        image: toDataUrlFromBuffer(bytes, mediaType),
        mediaType,
      });
      imagesIncluded++;
    } catch (err) {
      console.warn(
        "Failed to read image:",
        filePathValue,
        getErrorMessage(err),
      );
    }
  }

  return parts;
};
