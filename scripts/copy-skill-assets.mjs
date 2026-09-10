import { cp, rm } from "fs/promises";
import { fileURLToPath } from "url";

const source = fileURLToPath(new URL("../api/core/skills", import.meta.url));
const destination = fileURLToPath(
  new URL("../dist/api/core/skills", import.meta.url),
);

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
