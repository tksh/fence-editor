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
 */

import { parseArgs, getVersion, getHelpText } from "./args.ts";
import { getArgs, readStdin, readLine, exit, writeFile } from "./runtime.ts";
import { parseCommonMark } from "./parser/commonmark.ts";
import { parseDjot } from "./parser/djot.ts";
import type { FenceParser } from "./model/fence.ts";
import { createEditorState, reconstructOutput } from "./model/state.ts";
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
    console.log(getVersion());
    exit(0);
  }

  if (parsed.showHelp) {
    console.log(getHelpText());
    exit(0);
  }

  // 2. Read source content
  let source: string;
  const inputFile: string | null = parsed.inputFile;

  if (parsed.inputFile) {
    try {
      source = await Deno.readTextFile(parsed.inputFile);
    } catch (err) {
      console.error(`Error: Cannot read file "${parsed.inputFile}": ${err}`);
      exit(1);
    }
  } else {
    source = await readStdin();
    if (source.length === 0) {
      console.error("Error: No input provided. Use a file path or pipe stdin.");
      exit(1);
    }
  }

  // Preserve original lines for output reconstruction
  const originalLines = source.split("\n");

  // 3. Select parser
  const parser: FenceParser = parsed.format === "djot"
    ? parseDjot
    : parseCommonMark;

  // 4. Parse fences and create editor state
  const tokens = parser(source);

  if (tokens.length === 0) {
    console.error("No code fences found in the input.");
    exit(1);
  }

  const state = createEditorState(tokens, parsed.format);

  // 5. Run interactive loop — returns the modified state and destination
  const { state: finalState, destination } = await runInteractiveLoop(state);

  // 6. Reconstruct output: iterate originalLines, replace fence lines with
  //    the updated token.raw from finalState.outputTokens
  const output = reconstructOutput(finalState.outputTokens, originalLines);

  // 7. Handle output destination
  await handleOutput(destination, output, inputFile);

  exit(0);
}

/**
 * Handle the output based on user's destination choice.
 */
async function handleOutput(
  destination: OutputDestination,
  output: string,
  inputFile: string | null,
): Promise<void> {
  switch (destination) {
    case "stdout": {
      clearScreen();
      renderGoodbye();
      console.log(output);
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
      console.log(`Saved to ${inputFile}`);
      break;
    }
    case "save-new": {
      clearScreen();
      renderGoodbye();
      // Prompt for new file path
      const defaultName = inputFile
        ? inputFile.replace(/\.[^.]+$/, "") + "_edited.md"
        : "output.md";
      Deno.stdout.write(
        new TextEncoder().encode(`Enter file path [${defaultName}]: `),
      );
      const pathInput = await readLine();
      const filePath = pathInput.trim() || defaultName;
      await writeFile(filePath, output);
      console.log(`Saved to ${filePath}`);
      break;
    }
  }
}

main();
