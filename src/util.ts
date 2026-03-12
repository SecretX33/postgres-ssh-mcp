import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as fs from "node:fs";

// Load name/version from package.json (works from build/ after tsc)
const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_INFO = JSON.parse(
  fs.readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { name: string; version: string };
