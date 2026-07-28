/**
 * The language seam. A LanguageScanner turns a file's content into its imports (with the
 * symbols each pulls in) and its exports, and resolves an import specifier to an in-repo file.
 * Everything language-specific lives behind this interface; the composer (dependencies.ts) is
 * language-agnostic and just wires scanners together by file extension.
 *
 * Symbol semantics are shared across languages: a name is the exported/imported identifier,
 * "default" is a default export, and "*" means the whole module (a namespace that escapes, a
 * star import/re-export, or a dynamic/opaque import).
 */

/** Whole-module marker: the entire module's surface is pulled in / re-exported. */
export const WHOLE_MODULE = "*";
/** Default-export marker. */
export const DEFAULT_EXPORT = "default";

export interface ScannedImport {
  /** the specifier exactly as written in the source (e.g. "./x", "a.b", "react") */
  specifier: string;
  /** symbols this import pulls in: names, "default", or "*" (empty = side-effect-only import) */
  symbols: Set<string>;
}

export interface FileScanResult {
  imports: ScannedImport[];
  /** the file's exported names ("default", "*", or identifiers) */
  exports: Set<string>;
}

export interface LanguageScanner {
  /** file extensions this scanner owns, including the leading dot (e.g. ".ts") */
  readonly extensions: ReadonlySet<string>;
  /** parse a file's content into its imports (with symbols) and exports. Pure — no I/O. */
  scanFile(absFile: string, content: string): FileScanResult;
  /**
   * Resolve a specifier written in `fromFile` to the in-repo source file(s) it targets, or null
   * when it points outside the repo / at a third-party package / can't be resolved. Most languages
   * import a single file (return a string); Go imports a PACKAGE — a directory — so it returns
   * every non-test file of that package (an array). An edge is drawn to each.
   */
  resolveImport(specifier: string, fromFile: string): string | string[] | null;
}
