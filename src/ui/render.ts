/**
 * Status table and Actions rendering using ANSI escape sequences.
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
 */

import type { FenceToken } from "../model/fence.ts";
import type { EditorState } from "../model/state.ts";
import { truncate } from "../model/fence.ts";
import { getOutputPairs } from "../model/state.ts";

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
 */
export function clearScreen(): void {
  Deno.stdout.writeSync(out(CLEAR_SCREEN));
}

/**
 * Render the complete UI: Terms, Status table, Actions, and prompt.
 */
export function render(state: EditorState): void {
  clearScreen();

  renderTerms();
  renderStatusTable(state);
  const actions = generateActions(state);
  renderActions(actions);
  renderPrompt();
}

/**
 * Render the Terms section explaining I. and O. notation.
 */
function renderTerms(): void {
  const lines = [
    `${BOLD}Terms:${RESET}`,
    "",
    `  I. = fence pair id (input)`,
    `  O. = fence pair id (output)`,
    "",
    `${BOLD}Status:${RESET}`,
  ];
  for (const line of lines) {
    Deno.stdout.writeSync(out(line + "\n"));
  }
}

/**
 * Render the Status table with input and output columns side by side.
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
  Deno.stdout.writeSync(out(header + "\n"));

  // Separator
  const sep = formatSeparator();
  Deno.stdout.writeSync(out(sep + "\n"));

  // Build a map of input tokens by line
  const inputMap = buildTokenMap(state.inputTokens);
  const outputMap = buildTokenMap(state.outputTokens);

  // All unique line numbers that have fences (from input)
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
    const outputId = outputToken && outputToken.pairId > 0
      ? String(outputToken.pairId)
      : "";
    const outputRaw = outputToken
      ? truncate(outputToken.raw, COL_OUTPUT_W)
      : inputRaw; // If no output token, show input

    const row = formatRow(
      lineStr,
      inputRaw,
      inputId,
      outputId,
      outputRaw,
    );
    Deno.stdout.writeSync(out(row + "\n"));
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
 * Layout: | line | input                | I. | O. | output               |
 *         |-----:|:---------------------|---:|---:|:---------------------|
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

/** An action the user can take, with a display label. */
export interface Action {
  id: number;
  label: string;
  type: "restructure" | "increase-backtick" | "convert-tilde";
  /** For restructure actions: the pairId and new close line */
  pairId?: number;
  newCloseLine?: number;
}

/**
 * Generate the list of available actions from the current state.
 *
 * Actions:
 * 1. Restructure: for each pair, offer changing its close fence to another
 *    open fence's line (from a different pair).
 * 2. Increase backtick count: if nesting rule is violated.
 * 3. Convert tildes to backticks (conditional on hasTilde).
 */
export function generateActions(state: EditorState): Action[] {
  const actions: Action[] = [];

  // 1. Restructure actions: for each pair, show alternative close fences
  const pairs = getOutputPairs(state.outputTokens);
  const allFences = state.outputTokens.filter((t) => t.kind === "open");

  for (const pair of pairs) {
    // Find alternative close candidates: any open fence that comes after the current close
    for (const alt of allFences) {
      if (alt.pairId === pair.id) continue; // Skip same pair
      if (alt.line <= pair.close.line) continue; // Must be after current close
      // Check that this line isn't already used as a close by another pair
      const alreadyClose = state.outputTokens.find(
        (t) => t.line === alt.line && t.kind === "close",
      );
      if (alreadyClose) continue;

      actions.push({
        id: 0, // Will be assigned by renderActions
        label: `Change close fence for O.${pair.id} from line ${pair.close.line} to line ${alt.line}`,
        type: "restructure",
        pairId: pair.id,
        newCloseLine: alt.line,
      });
    }
  }

  // 2. Check for nesting violations (backtick count)
  const pairs2 = getOutputPairs(state.outputTokens);
  for (const outer of pairs2) {
    if (outer.open.symbol !== "backtick") continue;
    for (const inner of pairs2) {
      if (inner.id === outer.id) continue;
      if (inner.open.symbol !== "backtick") continue;
      if (
        inner.open.line > outer.open.line &&
        inner.close.line < outer.close.line
      ) {
        if (outer.open.backtickCount <= inner.open.backtickCount) {
          actions.push({
            id: 0,
            label: `Increase backtick count for O.${outer.id} (need ${inner.open.backtickCount + 1}, have ${outer.open.backtickCount})`,
            type: "increase-backtick",
            pairId: outer.id,
          });
        }
      }
    }
  }

  // 3. Convert tilde to backticks (if any tildes exist)
  if (state.hasTilde) {
    actions.push({
      id: 0,
      label: "Convert tilde fences to backticks",
      type: "convert-tilde",
    });
  }

  // Assign sequential IDs
  for (let i = 0; i < actions.length; i++) {
    actions[i].id = i + 1;
  }

  return actions;
}

/**
 * Render the Actions section with numbered choices.
 */
export function renderActions(actions: Action[]): void {
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out(`${BOLD}Actions (enter number to apply):${RESET}\n`));
  Deno.stdout.writeSync(out("\n"));

  if (actions.length === 0) {
    Deno.stdout.writeSync(out("  No actions available.\n"));
  } else {
    for (const action of actions) {
      Deno.stdout.writeSync(
        out(`  ${YELLOW}[${action.id}]${RESET} ${action.label}\n`),
      );
    }
  }
}

/**
 * Render the input prompt.
 */
export function renderPrompt(): void {
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out(`${CYAN}>${RESET} `));
}

/**
 * Render the output destination selector.
 */
export function renderOutputSelector(): void {
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out(`${BOLD}Choose output destination:${RESET}\n`));
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out("  [1] Save as new file\n"));
  Deno.stdout.writeSync(out("  [2] Overwrite input file\n"));
  Deno.stdout.writeSync(out("  [3] Print to stdout\n"));
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out(`${CYAN}>${RESET} `));
}

/**
 * Render a goodbye message.
 */
export function renderGoodbye(): void {
  Deno.stdout.writeSync(out("\n"));
  Deno.stdout.writeSync(out(`${DIM}Goodbye.${RESET}\n`));
}

/**
 * Render an error message.
 */
export function renderError(msg: string): void {
  Deno.stdout.writeSync(out(`\n\x1b[31mError: ${msg}\x1b[0m\n`));
}
