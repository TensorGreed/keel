/**
 * node:sqlite is behind an experimental flag and emits an ExperimentalWarning the moment
 * it is imported. Importing this module first installs a filter that drops exactly that
 * one warning — keeping MCP stderr and test output clean — without hiding anything else.
 *
 * This runs as an import side effect on purpose: ESM evaluates imports in source order,
 * so `import "./sqlite-warning.js"` placed above `import "node:sqlite"` patches
 * process.emitWarning before node:sqlite is ever evaluated.
 */
const real = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
  const text = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  (real as (w: string | Error, ...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
