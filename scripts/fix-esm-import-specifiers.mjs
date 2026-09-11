import fs from "node:fs/promises";
import fsNative from "node:fs";
import path from "node:path";

const DIST_ROOT = path.resolve(process.cwd(), "dist");
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".node", ".wasm"]);

const isRelativeSpecifier = (value) =>
  value.startsWith("./") || value.startsWith("../");

const resolveLocalSpecifier = (filePath, specifier) => {
  if (!isRelativeSpecifier(specifier)) {
    return specifier;
  }

  const extension = path.posix.extname(specifier);
  if (extension) {
    return specifier;
  }

  const absoluteBase = path.resolve(path.dirname(filePath), specifier);
  const fileCandidate = `${absoluteBase}.js`;
  if (fsNative.existsSync(fileCandidate)) {
    return `${specifier}.js`;
  }

  const indexCandidate = path.join(absoluteBase, "index.js");
  if (fsNative.existsSync(indexCandidate)) {
    return `${specifier}/index.js`;
  }

  return specifier;
};

const rewriteSpecifierLiterals = (content, filePath) => {
  const quotedSpecifierRegex = /((?:from|import)\s*\(?\s*["'])([^"']+)(["'])/g;
  return content.replace(
    quotedSpecifierRegex,
    (fullMatch, prefix, specifier, suffix) => {
      const resolved = resolveLocalSpecifier(filePath, specifier);
      return `${prefix}${resolved}${suffix}`;
    },
  );
};

const walk = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
      continue;
    }
    if (
      entry.isFile() &&
      (JS_EXTENSIONS.has(path.extname(entry.name)) || entry.name.endsWith(".d.ts"))
    ) {
      files.push(absolutePath);
    }
  }
  return files;
};

const main = async () => {
  if (!fsNative.existsSync(DIST_ROOT)) {
    return;
  }

  const files = await walk(DIST_ROOT);
  for (const filePath of files) {
    if (
      !filePath.endsWith(".js") &&
      !filePath.endsWith(".mjs") &&
      !filePath.endsWith(".d.ts")
    ) {
      continue;
    }

    const original = await fs.readFile(filePath, "utf8");
    const rewritten = rewriteSpecifierLiterals(original, filePath);
    if (rewritten !== original) {
      await fs.writeFile(filePath, rewritten, "utf8");
    }
  }
};

main().catch((error) => {
  console.error("Failed to rewrite ESM import specifiers:", error);
  process.exitCode = 1;
});
