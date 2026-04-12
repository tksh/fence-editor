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
  generateValidActions,
  clearScreen,
} from "./render.ts";
import { readLine } from "../runtime.ts";

/** Output destination choice. */
export type OutputDestination = "save-new" | "overwrite" | "stdout";

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

    // Exit on '0' or 'q'
    if (trimmed === "0" || trimmed === "q") {
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
  renderOutputSelector();

  while (true) {
    const input = await readLine();
    const trimmed = input.trim();

    if (trimmed === "1") return { state, destination: "save-new" };
    if (trimmed === "2") return { state, destination: "overwrite" };
    if (trimmed === "3") return { state, destination: "stdout" };

    renderError("Invalid choice. Enter 1, 2, or 3.");
  }
}

/**
 * Wait for the user to press Enter (after showing an error).
 */
async function waitEnter(): Promise<void> {
  await readLine();
}
