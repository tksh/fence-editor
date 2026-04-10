/**
 * Main interactive loop and input handling.
 *
 * Renders the UI, reads user input, applies actions to EditorState,
 * and returns the chosen output destination on exit.
 */

import type { EditorState } from "../model/state.ts";
import {
  restructureClose,
  convertTildesToBackticks,
} from "../model/state.ts";
import {
  render,
  renderOutputSelector,
  renderGoodbye,
  renderError,
  generateActions,
  type Action,
} from "./render.ts";
import { readLine } from "../runtime.ts";

/** Output destination choice. */
export type OutputDestination = "save-new" | "overwrite" | "stdout";

/**
 * Run the interactive editing loop.
 *
 * Displays the status table and actions, reads user input,
 * applies actions, and repeats until the user exits.
 *
 * Returns both the modified EditorState and the chosen output destination.
 */
export async function runInteractiveLoop(
  initialState: EditorState,
): Promise<{ state: EditorState; destination: OutputDestination }> {
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

    // Parse action number
    const choice = parseInt(trimmed, 10);
    if (isNaN(choice) || choice < 1) {
      renderError("Invalid input. Enter a number or '0'/'q' to exit.");
      await waitEnter();
      continue;
    }

    // Find the matching action
    const actions = generateActions(state);
    const action = actions.find((a) => a.id === choice);
    if (!action) {
      renderError(`No action with number ${choice}.`);
      await waitEnter();
      continue;
    }

    // Apply the action
    switch (action.type) {
      case "restructure": {
        if (action.pairId === undefined || action.newCloseLine === undefined) {
          renderError("Invalid restructure action.");
          await waitEnter();
          continue;
        }
        state = restructureClose(state, action.pairId, action.newCloseLine);
        break;
      }
      case "convert-tilde": {
        state = convertTildesToBackticks(state);
        break;
      }
      case "increase-backtick": {
        // This is informational — the auto-adjust already handles it.
        // We apply a manual +1 increase if requested.
        if (action.pairId !== undefined) {
          state = increaseBacktickCount(state, action.pairId);
        }
        break;
      }
    }
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
 * Increase the backtick count for all fences in a given pair by 1.
 */
function increaseBacktickCount(state: EditorState, pairId: number): EditorState {
  const newTokens = state.outputTokens.map((t) => {
    if (t.pairId === pairId) {
      return {
        ...t,
        backtickCount: t.backtickCount + 1,
      };
    }
    return { ...t };
  });
  return {
    ...state,
    outputTokens: newTokens,
    actionLog: [
      ...state.actionLog,
      `Increased backtick count for O.${pairId}`,
    ],
  };
}

/**
 * Wait for the user to press Enter (after showing an error).
 */
async function waitEnter(): Promise<void> {
  await readLine();
}
