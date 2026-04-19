/**
 * Main interactive loop and input handling.
 *
 * Renders the UI, reads user input, applies actions via applyAction(),
 * and returns the chosen output destination on exit.
 *
 * Ctrl+C is handled cleanly: SIGINT listener exits immediately without
 * triggering the save flow or throwing unhandled errors.
 */

import type { EditorState } from "../model/state.ts";
import { applyAction } from "../model/state.ts";
import {
  render,
  renderOutputSelector,
  renderGoodbye,
  renderError,
  renderStatusSaveConfirmation,
  generateValidActions,
  clearScreen,
} from "./render.ts";
import { readLine, writeFile } from "../runtime.ts";
import { generateDefaultOutputPath } from "../args.ts";

/** Output destination choice. */
export type OutputDestination = "save-new" | "overwrite" | "stdout" | "save-status" | "cancel";

/**
 * Run the interactive editing loop.
 *
 * Displays the status table and actions, reads user input,
 * applies actions via applyAction (which mutates outputTokens properly),
 * and repeats until the user exits.
 *
 * Returns both the modified EditorState and the chosen output destination.
 */
export async function runInteractiveLoop(
  initialState: EditorState,
): Promise<{ state: EditorState; destination: OutputDestination }> {
  // Clean Ctrl+C handling: abort immediately without saving
  Deno.addSignalListener("SIGINT", () => {
    clearScreen();
    renderGoodbye();
    Deno.exit(0);
  });

  let state = initialState;

  while (true) {
    // Render the full UI
    render(state);

    // Read user input
    const input = await readLine();
    const trimmed = input.trim().toLowerCase();

    // Exit on '0'
    if (trimmed === "0") {
      break;
    }

    // Empty or non-numeric input: silently re-prompt (no error noise)
    const choice = parseInt(trimmed, 10);
    if (isNaN(choice) || choice < 1) {
      continue;
    }

    // Look up the action in the current valid actions list
    const actions = generateValidActions(state);
    const action = actions.find((a) => a.id === choice);
    if (!action) {
      renderError(`No action with number ${choice}.`);
      await waitEnter();
      continue;
    }

    // Apply the action — this mutates outputTokens properly:
    // updates kind, pairId, backtickCount, regenerates raw strings,
    // and appends to actionLog.
    state = applyAction(state, choice);
  }

  // Show output destination selector
  renderOutputSelector(state.format);

  while (true) {
    const input = await readLine();
    const trimmed = input.trim();

    // Empty input: silently re-prompt
    if (trimmed.length === 0) continue;

    if (trimmed === "1") return { state, destination: "save-new" };
    if (trimmed === "2") return { state, destination: "overwrite" };
    if (trimmed === "3") return { state, destination: "stdout" };
    if (trimmed === "0") return { state, destination: "cancel" };

    // Option 4: Save status log inline (auxiliary) and return to save menu
    if (trimmed === "4") {
      const defaultName = generateDefaultOutputPath(null, state.format).replace(
        /_edited\.(md|dj)$/,
        ".edits.$1",
      );
      Deno.stderr.writeSync(
        new TextEncoder().encode(`Enter file path [${defaultName}]: `),
      );
      const pathInput = await readLine();
      const filePath = pathInput.trim() || defaultName;

      // Generate and save status log
      const exportContent = generateStatusLogContent(state.statusHistory);
      await writeFile(filePath, exportContent);

      renderStatusSaveConfirmation(filePath);
      renderOutputSelector(state.format);
      continue; // Return to save menu for main content export
    }

    renderError("Invalid choice. Enter 1, 2, 3, 4, or 0 to cancel.");
  }
}

/**
 * Generate status log content for export.
 */
function generateStatusLogContent(
  statusHistory: Array<{ actionLabel: string; table: string }>,
): string {
  const lines: string[] = [];

  lines.push("# Summary of Fence Edits");
  lines.push("");

  // Applied Actions section
  lines.push("## Applied Actions");
  lines.push("");
  for (const [idx, entry] of statusHistory.entries()) {
    if (idx === 0) continue; // Skip initial entry
    const actionNum = idx; // 1-based
    lines.push(`${actionNum}. ${entry.actionLabel}`);
  }
  lines.push("");

  // Status Changes section
  lines.push("## Status Changes");
  lines.push("");

  // Initial state
  lines.push("Initial:");
  lines.push("");
  lines.push(statusHistory[0].table);
  lines.push("");

  // Each action's resulting state as "Done: N. ..."
  for (const [idx, entry] of statusHistory.entries()) {
    if (idx === 0) continue;
    const actionNum = idx;
    lines.push("");
    lines.push(`Done: ${actionNum}. ${entry.actionLabel}`);
    lines.push("");
    lines.push(entry.table);
    lines.push("");
  }

  // Ensure trailing newline
  return lines.join("\n") + "\n";
}

/**
 * Wait for the user to press Enter (after showing an error).
 */
async function waitEnter(): Promise<void> {
  await readLine();
}
