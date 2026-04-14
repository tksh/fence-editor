/**
 * CLI option definitions and manual argument parser.
 *
 * Supports:
 *   --format <commonmark|djot>
 *   --version
 *   -h, --help
 *   [input-file]  (optional, stdin if absent)
 *
 * Auto-detection: when --format is omitted, the parser is inferred from the
 * input file extension (.md/.markdown/.mdx → commonmark, .dj/.djt → djot).
 * Unknown extensions and stdin fall back to commonmark.
 */

export interface ParsedArgs {
  /** Input file path, or null for stdin */
  inputFile: string | null;
  /** Explicit parser format from --format flag, or undefined if omitted */
  explicitFormat: "commonmark" | "djot" | undefined;
  /** Whether --version was requested */
  showVersion: boolean;
  /** Whether -h/--help was requested */
  showHelp: boolean;
}

const VERSION = "0.1.0";

const HELP_TEXT = `Usage: fence-editor [input-file] [options]

Options:
  --format <commonmark|djot>  Set parser format (default: auto-detect from extension)
  --version                   Show version information
  -h, --help                  Show this help

Auto-Detection:
  .md, .markdown, .mdx → CommonMark
  .dj, .djt             → Djot
  Unknown extension or stdin → CommonMark

Interactive Mode:
  Enter a number from Actions to apply changes to the fence structure.
  Press 0 or q to exit, choose an output destination, and save changes.
  Press Ctrl+C to abort immediately without saving any changes.
  Output destinations: [1] Save as new file, [2] Overwrite input, [3] Print to stdout

Examples:
  fence-editor input.md              # auto-detects CommonMark
  fence-editor notes.dj              # auto-detects Djot
  fence-editor input.md --format djot  # override to Djot
  cat input.dj | fence-editor          # stdin, falls back to CommonMark`;

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    inputFile: null,
    explicitFormat: undefined,
    showVersion: false,
    showHelp: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--version") {
      result.showVersion = true;
      i++;
    } else if (arg === "-h" || arg === "--help") {
      result.showHelp = true;
      i++;
    } else if (arg === "--format") {
      const next = argv[i + 1];
      if (next === "commonmark" || next === "djot") {
        result.explicitFormat = next;
        i += 2;
      } else {
        // Invalid format value — skip
        i += 2;
      }
    } else if (!arg.startsWith("-")) {
      // Positional argument: input file
      result.inputFile = arg;
      i++;
    } else {
      // Unknown option — skip
      i++;
    }
  }

  return result;
}

/**
 * Resolve the parser format from input file extension.
 *
 * Priority:
 * 1. explicitFormat from --format flag (if provided)
 * 2. Auto-detect from file extension
 * 3. Fallback to "commonmark"
 */
export function resolveFormat(
  inputPath: string | null,
  explicitFormat: "commonmark" | "djot" | undefined,
): "commonmark" | "djot" {
  if (explicitFormat) return explicitFormat;
  if (!inputPath) return "commonmark";

  const ext = getFileExtension(inputPath).toLowerCase();

  switch (ext) {
    case "dj":
    case "djt":
      return "djot";
    case "md":
    case "markdown":
    case "mdx":
    default:
      return "commonmark";
  }
}

/**
 * Generate a default output filename based on the input path and resolved format.
 *
 * - If input is a file: replace or append _edited suffix with the correct extension.
 *   e.g., test/00.dj → test/00_edited.dj, doc.md → doc_edited.md
 * - If input is stdin (null): fall back to edited_output.<ext>
 */
export function generateDefaultOutputPath(
  inputPath: string | null,
  format: "commonmark" | "djot",
): string {
  const ext = format === "djot" ? ".dj" : ".md";

  if (!inputPath) {
    return `edited_output${ext}`;
  }

  // Extract directory, base name, and existing extension
  const lastSlash = inputPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? inputPath.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? inputPath.slice(lastSlash + 1) : inputPath;

  const dotIdx = fileName.lastIndexOf(".");
  const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;

  return `${dir}${base}_edited${ext}`;
}

/**
 * Extract the file extension (without the leading dot).
 * Returns empty string if no extension is present.
 */
function getFileExtension(path: string): string {
  const fileName = path.includes("/")
    ? path.slice(path.lastIndexOf("/") + 1)
    : path;
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx > 0 ? fileName.slice(dotIdx + 1) : "";
}

export function getVersion(): string {
  return `fence-editor ${VERSION}`;
}

export function getHelpText(): string {
  return HELP_TEXT;
}
