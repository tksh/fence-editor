/**
 * Status table and Actions rendering using ANSI escape sequences.
 *
 * ALL UI output goes to stderr. This separates interactive UI from the
 * data stream, enabling clean stdout piping:
 *
 *   cat file.md | deno run ... | grep "code"
 *
 * Only the reconstructed file content (destination [3]) writes to stdout.
 *
 * Layout (total ≤ 80 chars):
 * | line | input                | I. | O. | output               |
 * |-----:|:---------------------|---:|---:|:---------------------|
 *
 * Column widths:
 *   line:   6 chars (right-aligned)
 *   input:  22 chars (left-aligned, truncated)
 *   I.:     4 chars (right-aligned)
 *   O.:     4 chars (right-aligned)
 *   output: 22 chars (left-aligned, truncated)
 *
 * Total content: 6 + 22 + 4 + 4 + 22 = 58
 * Pipes + spaces: 5 pipes + 8 spaces = 13
 * Total: 58 + 13 = 71 (within 80-char limit)
 *
 * The output column renders state.outputTokens[i].raw directly.
 * The O. column renders state.outputTokens[i].pairId directly.
 * Redraw always uses state.outputTokens — no separate UI state array.
 */

import type { EditorState } from "../model/state.ts";
import {
  generateValidActions,
  type Action,
  getOutputPairs,
} from "../model/state.ts";
import type { FenceToken } from "../model/fence.ts";
import { truncate } from "../model/fence.ts";

const COL_LINE_W = 6;
const COL_INPUT_W = 22;
const COL_ID_W = 4;
const COL_OUTPUT_W = 22;

/** ANSI codes */
const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

/**
 * Encode a string for terminal output.
 */
function out(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Clear the screen and move cursor to top-left.
 * Written to stderr — the interactive terminal display.
 */
export function clearScreen(): void {
  Deno.stderr.writeSync(out(CLEAR_SCREEN));
}

/**
 * Render the complete UI: Terms, format indicator, Status table, Actions, and prompt.
 * All UI goes to stderr.
 */
export function render(state: EditorState): void {
  clearScreen();

  renderTerms(state);
  renderStatusTable(state);
  const actions = generateValidActions(state);
  renderActions(actions);
  renderPrompt();
}

/**
 * Render the Terms section explaining I. and O. notation, plus the parser format.
 * Written to stderr.
 */
function renderTerms(state: EditorState): void {
  const formatLabel = state.format === "djot" ? "Djot" : "CommonMark";
  const lines = [
    `${BOLD}Terms:${RESET}`,
    "",
    `  I. = fence pair id (input)`,
    `  O. = fence pair id (output)`,
    "",
    `Parsed as ${formatLabel}`,
    "",
    `${BOLD}Status:${RESET}`,
    "",
  ];
  for (const line of lines) {
    Deno.stderr.writeSync(out(line + "\n"));
  }
}

/**
 * Render the Status table with input and output columns side by side.
 * Written to stderr.
 *
 * - "output" column renders state.outputTokens[i].raw (truncated to 22 chars).
 * - "O." column renders state.outputTokens[i].pairId.
 * - All data comes from state.outputTokens directly — no separate UI array.
 */
function renderStatusTable(state: EditorState): void {
  // Header
  const header = formatRow(
    "line",
    "input",
    "I.",
    "O.",
    "output",
  );
  Deno.stderr.writeSync(out(header + "\n"));

  // Separator
  const sep = formatSeparator();
  Deno.stderr.writeSync(out(sep + "\n"));

  // Build maps from line number to FenceToken
  const inputMap = buildTokenMap(state.inputTokens);
  const outputMap = buildTokenMap(state.outputTokens);

  // All unique line numbers that have fences
  const allLines = new Set<number>();
  for (const t of state.inputTokens) allLines.add(t.line);
  for (const t of state.outputTokens) allLines.add(t.line);
  const sortedLines = [...allLines].sort((a, b) => a - b);

  for (const lineNum of sortedLines) {
    const inputToken = inputMap.get(lineNum);
    const outputToken = outputMap.get(lineNum);

    const lineStr = String(lineNum);
    const inputRaw = inputToken ? truncate(inputToken.raw, COL_INPUT_W) : "";
    const inputId = inputToken && inputToken.pairId > 0
      ? String(inputToken.pairId)
      : "";

    // O. column: reads directly from state.outputTokens[i].pairId
    const outputId = outputToken && outputToken.pairId > 0
      ? String(outputToken.pairId)
      : "";

    // output column: reads directly from state.outputTokens[i].raw
    const outputRaw = outputToken
      ? truncate(outputToken.raw, COL_OUTPUT_W)
      : "";

    const row = formatRow(
      lineStr,
      inputRaw,
      inputId,
      outputId,
      outputRaw,
    );
    Deno.stderr.writeSync(out(row + "\n"));
  }

  // Render pair summary
  const pairs = getOutputPairs(state.outputTokens);
  if (pairs.length > 0) {
    Deno.stderr.writeSync(out("\n"));
    for (const pair of pairs) {
      Deno.stderr.writeSync(
        out(
          `  ${GREEN}O.${pair.id}${RESET}: line ${pair.open.line} → line ${pair.close.line} (${pair.open.symbol}, ${pair.open.backtickCount}x)\n`,
        ),
      );
    }
  }
}

/**
 * Build a map from line number to FenceToken.
 */
function buildTokenMap(tokens: ReadonlyArray<FenceToken>): Map<number, FenceToken> {
  const map = new Map<number, FenceToken>();
  for (const t of tokens) {
    map.set(t.line, t);
  }
  return map;
}

/**
 * Format a table row with proper column widths and alignment.
 */
function formatRow(
  line: string,
  input: string,
  inputId: string,
  outputId: string,
  output: string,
): string {
  const col1 = padLeft(line, COL_LINE_W);
  const col2 = padRight(truncate(input, COL_INPUT_W), COL_INPUT_W);
  const col3 = padLeft(inputId, COL_ID_W);
  const col4 = padLeft(outputId, COL_ID_W);
  const col5 = padRight(truncate(output, COL_OUTPUT_W), COL_OUTPUT_W);

  return `|${col1}|${col2}|${col3}|${col4}|${col5}|`;
}

/**
 * Format the table separator row.
 */
function formatSeparator(): string {
  const col1 = "-".repeat(COL_LINE_W);
  const col2 = "-".repeat(COL_INPUT_W);
  const col3 = "-".repeat(COL_ID_W);
  const col4 = "-".repeat(COL_ID_W);
  const col5 = "-".repeat(COL_OUTPUT_W);

  return `|${col1}|${col2}|${col3}|${col4}|${col5}|`;
}

/**
 * Pad a string on the left to reach target width.
 */
function padLeft(s: string, width: number): string {
  if (s.length >= width) return s;
  return " ".repeat(width - s.length) + s;
}

/**
 * Pad a string on the right to reach target width.
 */
function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

/**
 * Re-export Action and generateValidActions for consumers (loop.ts)
 */
export { generateValidActions, type Action };

/**
 * Render the Actions section with numbered choices.
 * Written to stderr.
 */
export function renderActions(actions: Action[]): void {
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(
    out(`${BOLD}Actions:${RESET}\n`),
  );
  Deno.stderr.writeSync(out("\n"));

  if (actions.length === 0) {
    Deno.stderr.writeSync(out("  No actions available.\n"));
  } else {
    for (const action of actions) {
      Deno.stderr.writeSync(
        out(`  ${YELLOW}[${action.id}]${RESET} ${action.label}\n`),
      );
    }
  }

  // Persistent hint footer (within 80 chars)
  Deno.stderr.writeSync(
    out(`\n  ${DIM}> Enter action # | 0 or q to exit & save | Ctrl+C to cancel${RESET}\n`),
  );
}

/**
 * Render the input prompt.
 * Written to stderr.
 */
export function renderPrompt(): void {
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(out(`${CYAN}>${RESET} `));
}

/**
 * Render the output destination selector.
 * Written to stderr.
 */
export function renderOutputSelector(): void {
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(out(`${BOLD}Choose output destination:${RESET}\n`));
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(out("  [1] Save as new file\n"));
  Deno.stderr.writeSync(out("  [2] Overwrite input file\n"));
  Deno.stderr.writeSync(out("  [3] Print to stdout\n"));
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(out(`${CYAN}>${RESET} `));
}

/**
 * Render a goodbye message.
 * Written to stderr.
 */
export function renderGoodbye(): void {
  Deno.stderr.writeSync(out("\n"));
  Deno.stderr.writeSync(out(`${DIM}Goodbye.${RESET}\n`));
}

/**
 * Render an error message.
 * Written to stderr.
 */
export function renderError(msg: string): void {
  Deno.stderr.writeSync(out(`\n\x1b[31mError: ${msg}\x1b[0m\n`));
}
