// tsc only emits JS; the SQLite schema is a .sql asset the store reads at runtime
// relative to its own module. Copy it next to the compiled store so dist/ is runnable.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dest = "dist/events/schema.sql";
mkdirSync(dirname(dest), { recursive: true });
copyFileSync("src/events/schema.sql", dest);
