/**
 * CLI entry point.
 *
 * Flow:
 * 1. Parse CLI arguments (--format, --version, -h/--help, input file).
 * 2. Read source (from file or stdin).
 * 3. Parse fences using the selected format's parser.
 * 4. Create EditorState and run the interactive loop.
 * 5. On exit, reconstruct output by replacing fence lines in original source
 *    with the updated token.raw from outputTokens.
 * 6. Handle output destination (save/overwrite/stdout).
 *
 * Strict stream separation:
 * - ALL UI (tables, prompts, errors, goodbye) → stderr
 * - ONLY reconstructed file content (destination [3]) → stdout
 */

import {
  parseArgs,
  getVersion,
  getHelpText,
  resolveFormat,
  generateDefaultOutputPath,
} from "./args.ts";
import { getArgs, readStdin, readLine, exit, writeFile } from "./runtime.ts";
import { parseCommonMark } from "./parser/commonmark.ts";
import { parseDjot } from "./parser/djot.ts";
import type { FenceParser } from "./model/fence.ts";
import { createEditorState, reconstructOutput, type EditorState } from "./model/state.ts";
import {
  runInteractiveLoop,
  type OutputDestination,
} from "./ui/loop.ts";
import { clearScreen, renderGoodbye, renderError } from "./ui/render.ts";

async function main(): Promise<void> {
  // 1. Parse CLI arguments
  const argv = getArgs();
  const parsed = parseArgs(argv);

  if (parsed.showVersion) {
    Deno.stderr.writeSync(new TextEncoder().encode(getVersion() + "\n"));
    exit(0);
  }

  if (parsed.showHelp) {
    Deno.stderr.writeSync(new TextEncoder().encode(getHelpText() + "\n"));
    exit(0);
  }

  // 2. Read source content
  let source: string;
  const inputFile: string | null = parsed.inputFile;

  if (parsed.inputFile) {
    try {
      source = await Deno.readTextFile(parsed.inputFile);
    } catch (err) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `Error: Cannot read file "${parsed.inputFile}": ${err}\n`,
        ),
      );
      exit(1);
    }
  } else {
    source = await readStdin();
    if (source.length === 0) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          "Error: No input provided. Use a file path or pipe stdin.\n",
        ),
      );
      exit(1);
    }
  }

  // Resolve format: explicit flag > auto-detect from extension > commonmark
  const resolvedFormat = resolveFormat(inputFile, parsed.explicitFormat);

  // Preserve original lines for output reconstruction
  const originalLines = source.split("\n");

  // 3. Select parser
  const parser: FenceParser = resolvedFormat === "djot"
    ? parseDjot
    : parseCommonMark;

  // 4. Parse fences and create editor state
  const tokens = parser(source);

  if (tokens.length === 0) {
    Deno.stderr.writeSync(
      new TextEncoder().encode("No code fences found in the input.\n"),
    );
    exit(1);
  }

  let state = createEditorState(tokens, resolvedFormat);

  // 5. Run interactive loop — may return "cancel" to continue editing
  let destination: OutputDestination;
  while (true) {
    const result = await runInteractiveLoop(state);
    state = result.state;
    destination = result.destination;
    if (destination !== "cancel") break;
  }

  // 6. Reconstruct output: iterate originalLines, replace fence lines with
  //    the updated token.raw from finalState.outputTokens
  const output = reconstructOutput(state.outputTokens, originalLines);

  // 7. Handle output destination
  await handleOutput(destination, output, inputFile, resolvedFormat, state, originalLines);

  exit(0);
}

/**
 * Handle the output based on user's destination choice.
 *
 * ONLY destination [3] "stdout" writes to DENO.STDOUT.
 * All other messages (goodbye, errors, confirmations) go to STDERR.
 */
async function handleOutput(
  destination: OutputDestination,
  output: string,
  inputFile: string | null,
  format: "commonmark" | "djot",
  state: EditorState,
  originalLines: string[],
): Promise<void> {
  switch (destination) {
    case "stdout": {
      // Write ONLY the file content to stdout — no ANSI codes, no UI text
      const encoder = new TextEncoder();
      Deno.stdout.writeSync(encoder.encode(output + "\n"));
      break;
    }
    case "overwrite": {
      if (!inputFile) {
        clearScreen();
        renderGoodbye();
        renderError(
          "Cannot overwrite: input came from stdin. Choose 'Save as new file' instead.",
        );
        exit(1);
      }
      clearScreen();
      renderGoodbye();
      await writeFile(inputFile, output);
      Deno.stderr.writeSync(
        new TextEncoder().encode(`Saved to ${inputFile}\n`),
      );
      break;
    }
    case "save-new": {
      clearScreen();
      renderGoodbye();
      // Format-aware default output path
      const defaultName = generateDefaultOutputPath(inputFile, format);
      Deno.stderr.writeSync(
        new TextEncoder().encode(`Enter file path [${defaultName}]: `),
      );
      const pathInput = await readLine();
      const filePath = pathInput.trim() || defaultName;
      await writeFile(filePath, output);
      Deno.stderr.writeSync(
        new TextEncoder().encode(`Saved to ${filePath}\n`),
      );
      break;
    }
  }
}

main();
