/**
 * CLI option definitions and manual argument parser.
 *
 * Supports:
 *   --format <commonmark|djot>
 *   --version
 *   -h, --help
 *   [input-file]  (optional, stdin if absent)
 */

export interface ParsedArgs {
  /** Input file path, or null for stdin */
  inputFile: string | null;
  /** Parser format: 'commonmark' or 'djot' */
  format: "commonmark" | "djot";
  /** Whether --version was requested */
  showVersion: boolean;
  /** Whether -h/--help was requested */
  showHelp: boolean;
}

const VERSION = "0.1.0";

const HELP_TEXT = `Usage: fence-editor [input-file] [options]

Options:
  --format <commonmark|djot>  Set parser format (default: commonmark)
  --version                   Show version information
  -h, --help                  Show this help

Interactive Mode:
  Enter a number from Actions to apply changes to the fence structure.
  Press 0 or q to exit, choose an output destination, and save changes.
  Press Ctrl+C to abort immediately without saving any changes.
  Output destinations: [1] Save as new file, [2] Overwrite input, [3] Print to stdout

Examples:
  fence-editor input.md
  fence-editor input.md --format djot
  cat input.md | fence-editor --format commonmark`;

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    inputFile: null,
    format: "commonmark",
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
        result.format = next;
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

export function getVersion(): string {
  return `fence-editor ${VERSION}`;
}

export function getHelpText(): string {
  return HELP_TEXT;
}
