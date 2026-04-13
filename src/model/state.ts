/**
 * EditorState and restructuring logic.
 *
 * Core API:
 * - pairFences(tokens): Pure, reusable pairing function
 * - generateValidActions(state): Actions validated by pairing simulation
 * - applyAction(state, actionIndex): Applies action with proper state mutation
 * - reconstructOutput(tokens, lines): Reconstructs source with updated fences
 */

import type { FenceToken } from "./fence.ts";
import { truncate } from "./fence.ts";

// ─── EditorState ────────────────────────────────────────────────

export interface EditorState {
  inputTokens: ReadonlyArray<FenceToken>;
  outputTokens: FenceToken[];
  hasTilde: boolean;
  actionLog: string[];
}

export function createEditorState(tokens: FenceToken[]): EditorState {
  const inputTokens = Object.freeze(tokens.map((t) => ({ ...t })));
  const outputTokens = tokens.map((t) => ({ ...t }));
  const hasTilde = tokens.some((t) => t.symbol === "tilde");
  return { inputTokens, outputTokens, hasTilde, actionLog: [] };
}

// ─── Pure Pairing Function ──────────────────────────────────────

/**
 * Pair fences using CommonMark/Djot rules:
 * - infostring present → forced open
 * - kind="open" (explicit) → forced open (enables swap validation)
 * - no infostring + not explicit open → shortest-match stack pairing
 * - backtick and tilde treated independently
 * - pairIds are 1-based sequential
 *
 * Pure function: does not mutate input tokens.
 */
export function pairFences(tokens: FenceToken[]): FenceToken[] {
  const result = tokens.map((t) => ({ ...t, pairId: 0 }));

  const symbols: Array<"backtick" | "tilde"> = ["backtick", "tilde"];
  let nextPairId = 1;

  for (const sym of symbols) {
    const indices = result
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.symbol === sym)
      .sort((a, b) => a.t.line - b.t.line)
      .map(({ i }) => i);

    const stack: number[] = [];

    for (const idx of indices) {
      const tok = result[idx];

      if (tok.infostring !== null || tok.kind === "open") {
        // Forced open — infostring or explicit kind="open" from simulation
        tok.kind = "open";
        stack.push(idx);
      } else if (tok.kind === "close") {
        // Explicitly marked as close — try shortest-match
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
        } else {
          // No matching open — treat as open
          tok.kind = "open";
          stack.push(idx);
        }
      } else {
        // No infostring and not explicitly close — ambiguous, shortest-match
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
        } else {
          // No open to match — treat as open
          tok.kind = "open";
          stack.push(idx);
        }
      }
    }

    // Unmatched opens remain as opens with pairId 0 (unpaired)
    for (const idx of stack) {
      result[idx].pairId = 0;
    }
  }

  return result;
}

// ─── Action Type ────────────────────────────────────────────────

export interface Action {
  id: number;
  label: string;
  type: "restructure" | "increase-backtick" | "convert-tilde";
  /** For restructure/increase-backtick: the target pairId */
  pairId?: number;
  /** For restructure: the line number of the new close fence */
  newCloseLine?: number;
  /** For swap-based restructure: the auto-paired pair's original ID */
  swapPairId?: number;
}

// ─── Pairing Structure Comparison ───────────────────────────────

/**
 * Build a canonical representation of the pairing structure.
 * Returns a sorted array of "openLine-closeLine" strings.
 */
function getPairingStructure(tokens: FenceToken[]): string[] {
  const pairs = getOutputPairs(tokens);
  const struct = pairs.map((p) => `${p.open.line}-${p.close.line}`);
  struct.sort();
  return struct;
}

function structuresEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Internal Helpers ───────────────────────────────────────────

function findTokenIdx(
  tokens: FenceToken[],
  line: number,
  symbol: FenceToken["symbol"],
): number {
  return tokens.findIndex((t) => t.line === line && t.symbol === symbol);
}

function cloneTokens(tokens: FenceToken[]): FenceToken[] {
  return tokens.map((t) => ({ ...t }));
}

// ─── Swap Simulation ───────────────────────────────────────────

/**
 * Simulate swapping close fences between two pairs A and B.
 * A comes before B (A.close.line < B.open.line).
 *
 * Proposed new pairing: A' = (A.open, B.close), B' = (A.close, B.open)
 *
 * This transforms two adjacent non-nested pairs into a nested structure.
 */
interface SwapResult {
  valid: boolean;
  /** The paired tokens if valid */
  paired?: FenceToken[];
}

function simulatePairSwap(
  tokens: FenceToken[],
  A: FencePairInfo,
  B: FencePairInfo,
): SwapResult {
  // Must be same symbol type
  if (A.open.symbol !== B.open.symbol) return { valid: false };

  // A must come before B
  if (A.close.line >= B.open.line) return { valid: false };

  const cloned = cloneTokens(tokens);

  // Find the 4 tokens by line+symbol
  const aOpenIdx = findTokenIdx(cloned, A.open.line, A.open.symbol);
  const aCloseIdx = findTokenIdx(cloned, A.close.line, A.close.symbol);
  const bOpenIdx = findTokenIdx(cloned, B.open.line, B.open.symbol);
  const bCloseIdx = findTokenIdx(cloned, B.close.line, B.close.symbol);

  if (aOpenIdx < 0 || aCloseIdx < 0 || bOpenIdx < 0 || bCloseIdx < 0) {
    return { valid: false };
  }

  // Apply the swap:
  // A.close → open (becomes B' open)
  cloned[aCloseIdx] = {
    ...cloned[aCloseIdx],
    kind: "open" as const,
    pairId: 0,
  };
  // B.open → close (becomes B' close)
  cloned[bOpenIdx] = {
    ...cloned[bOpenIdx],
    kind: "close" as const,
    infostring: null,
    pairId: 0,
  };
  // Reset pairIds for the other two (pairFences resets all anyway)
  cloned[aOpenIdx].pairId = 0;
  cloned[bCloseIdx].pairId = 0;

  // Run pairFences on the cloned tokens
  const paired = pairFences(cloned);

  // Validity check 1: ALL tokens must be paired (pairId > 0)
  if (paired.some((t) => t.pairId === 0)) return { valid: false };

  // Validity check 2: the resulting pairing structure must differ
  const currentStructure = getPairingStructure(tokens);
  const newStructure = getPairingStructure(paired);
  if (structuresEqual(currentStructure, newStructure)) return { valid: false };

  return { valid: true, paired };
}

// ─── Single Close Change Simulation ─────────────────────────────

/**
 * Simulate moving one pair's close fence to an unpaired token.
 * Only valid for non-overlapping cases.
 */
function simulateSingleCloseChange(
  tokens: FenceToken[],
  pair: FencePairInfo,
  candidate: FenceToken,
): SwapResult {
  const cloned = cloneTokens(tokens);

  const oldCloseIdx = findTokenIdx(cloned, pair.close.line, pair.close.symbol);
  const candidateIdx = findTokenIdx(cloned, candidate.line, candidate.symbol);

  if (oldCloseIdx < 0 || candidateIdx < 0) return { valid: false };

  // Promote old close to open
  cloned[oldCloseIdx] = {
    ...cloned[oldCloseIdx],
    kind: "open" as const,
    pairId: 0,
  };
  // Set candidate as close
  cloned[candidateIdx] = {
    ...cloned[candidateIdx],
    kind: "close" as const,
    infostring: null,
    pairId: 0,
  };

  // Run pairFences
  const paired = pairFences(cloned);

  // Validity check 1: ALL tokens must be paired
  if (paired.some((t) => t.pairId === 0)) return { valid: false };

  // Validity check 2: structure must differ
  const currentStructure = getPairingStructure(tokens);
  const newStructure = getPairingStructure(paired);
  if (structuresEqual(currentStructure, newStructure)) return { valid: false };

  return { valid: true, paired };
}

// ─── Action Generation with Pairing Simulation ──────────────────

/**
 * Generate all valid actions from the current state.
 *
 * Restructure actions are validated by running pairFences on a clone:
 * 1. Pairwise close-swap: cross-pair two adjacent non-nested pairs into nesting
 * 2. Single close change: move one pair's close to an unpaired token
 *
 * An action is valid ONLY if:
 * - pairFences on the cloned tokens produces zero orphans
 * - The resulting pairing structure differs from the current state
 */
export function generateValidActions(state: EditorState): Action[] {
  const actions: Action[] = [];
  const tokens = state.outputTokens;
  const pairs = getOutputPairs(tokens);

  // 1. Pairwise close-swap: for each pair of pairs (A, B) where A comes before B
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const A = pairs[i];
      const B = pairs[j];

      const result = simulatePairSwap(tokens, A, B);
      if (!result.valid) continue;

      actions.push({
        id: 0,
        label:
          `Change close fence for O.${A.id} from line ${A.close.line} to line ${B.close.line} (auto-pairs O.${B.id} to line ${B.open.line})`,
        type: "restructure",
        pairId: A.id,
        newCloseLine: B.close.line,
        swapPairId: B.id,
      });
    }
  }

  // 2. Single close change (fallback): move one pair's close to an unpaired token
  const unpairedTokens = tokens.filter((t) => t.pairId === 0);
  for (const pair of pairs) {
    for (const candidate of unpairedTokens) {
      if (candidate.symbol !== pair.open.symbol) continue;
      if (candidate.line <= pair.open.line) continue;
      if (candidate.line === pair.close.line) continue;

      const result = simulateSingleCloseChange(tokens, pair, candidate);
      if (!result.valid) continue;

      actions.push({
        id: 0,
        label:
          `Change close fence for O.${pair.id} from line ${pair.close.line} to line ${candidate.line}`,
        type: "restructure",
        pairId: pair.id,
        newCloseLine: candidate.line,
      });
    }
  }

  // 3. Increase fence count actions: detect nesting violations per symbol type
  for (const outer of pairs) {
    for (const inner of pairs) {
      if (inner.id === outer.id) continue;
      if (inner.open.symbol !== outer.open.symbol) continue;
      if (
        inner.open.line > outer.open.line &&
        inner.close.line < outer.close.line
      ) {
        if (outer.open.backtickCount <= inner.open.backtickCount) {
          const symLabel = outer.open.symbol === "backtick"
            ? "backtick"
            : "tilde";
          actions.push({
            id: 0,
            label:
              `Increase ${symLabel} count for O.${outer.id} (need ${inner.open.backtickCount + 1}, have ${outer.open.backtickCount})`,
            type: "increase-backtick",
            pairId: outer.id,
          });
        }
      }
    }
  }

  // 4. Convert tilde to backticks (if any tildes exist)
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

// ─── State Mutation on Action Apply ─────────────────────────────

/**
 * Apply an action by its display ID, mutating outputTokens properly:
 * - Updates kind, pairId, backtickCount
 * - Regenerates raw string from token properties
 * - Appends description to actionLog
 */
export function applyAction(
  state: EditorState,
  actionIndex: number,
): EditorState {
  const actions = generateValidActions(state);
  const action = actions.find((a) => a.id === actionIndex);
  if (!action) return state;

  switch (action.type) {
    case "restructure":
      return applyRestructure(state, action);
    case "increase-backtick":
      return applyIncreaseBacktick(state, action);
    case "convert-tilde":
      return applyConvertTilde(state);
  }
}

/**
 * Apply a restructure action (swap or single-change).
 *
 * For swap actions: modifies both pairs' open/close tokens, runs pairFences,
 * auto-adjusts backticks, and regenerates raw strings.
 *
 * For single-change actions: promotes old close to open, sets new close,
 * runs pairFences, auto-adjusts backticks, and regenerates raw strings.
 */
function applyRestructure(state: EditorState, action: Action): EditorState {
  const { pairId, newCloseLine, swapPairId } = action;
  if (pairId === undefined || newCloseLine === undefined) return state;

  const tokens = state.outputTokens;
  const pairs = getOutputPairs(tokens);
  const A = pairs.find((p) => p.id === pairId);
  if (!A) return state;

  const cloned = cloneTokens(tokens);

  if (swapPairId !== undefined) {
    // Swap case: A' = (A.open, B.close), B' = (A.close, B.open)
    const B = pairs.find((p) => p.id === swapPairId);
    if (!B) return state;

    const aOpenIdx = findTokenIdx(cloned, A.open.line, A.open.symbol);
    const aCloseIdx = findTokenIdx(cloned, A.close.line, A.close.symbol);
    const bOpenIdx = findTokenIdx(cloned, B.open.line, B.open.symbol);
    const bCloseIdx = findTokenIdx(cloned, B.close.line, B.close.symbol);

    if (aOpenIdx < 0 || aCloseIdx < 0 || bOpenIdx < 0 || bCloseIdx < 0) {
      return state;
    }

    // A.close → open, B.open → close
    cloned[aCloseIdx] = {
      ...cloned[aCloseIdx],
      kind: "open" as const,
      pairId: 0,
    };
    cloned[bOpenIdx] = {
      ...cloned[bOpenIdx],
      kind: "close" as const,
      infostring: null,
      pairId: 0,
    };
    cloned[aOpenIdx].pairId = 0;
    cloned[bCloseIdx].pairId = 0;
  } else {
    // Single change: move A's close to newCloseLine
    const oldCloseIdx = findTokenIdx(cloned, A.close.line, A.close.symbol);
    const newCloseIdx = findTokenIdx(cloned, newCloseLine, A.open.symbol);

    if (oldCloseIdx < 0 || newCloseIdx < 0) return state;

    cloned[oldCloseIdx] = {
      ...cloned[oldCloseIdx],
      kind: "open" as const,
      pairId: 0,
    };
    cloned[newCloseIdx] = {
      ...cloned[newCloseIdx],
      kind: "close" as const,
      infostring: null,
      pairId: 0,
    };
  }

  // Re-pair all tokens (pure function)
  const paired = pairFences(cloned);

  // Auto-adjust backticks for nesting compliance
  const adjusted = autoAdjustBackticks(paired);

  return {
    ...state,
    outputTokens: adjusted,
    actionLog: [...state.actionLog, action.label],
  };
}

function applyIncreaseBacktick(
  state: EditorState,
  action: Action,
): EditorState {
  const { pairId } = action;
  if (pairId === undefined) return state;

  const tokens = state.outputTokens;
  const pairs = getOutputPairs(tokens);
  const outer = pairs.find((p) => p.id === pairId);
  if (!outer) return state;

  // Find the maximum required fence count from nested inner fences (same symbol)
  let required = outer.open.backtickCount;
  for (const inner of pairs) {
    if (inner.id === outer.id) continue;
    if (inner.open.symbol !== outer.open.symbol) continue;
    if (
      inner.open.line > outer.open.line &&
      inner.close.line < outer.close.line
    ) {
      const min = inner.open.backtickCount + 1;
      if (min > required) required = min;
    }
  }

  // Update all tokens in the outer pair, regenerating raw strings
  const newTokens = tokens.map((t) => {
    if (t.pairId === pairId) {
      const updated = { ...t, backtickCount: required };
      return { ...updated, raw: rebuildRaw(updated) };
    }
    return { ...t };
  });

  return {
    ...state,
    outputTokens: newTokens,
    actionLog: [
      ...state.actionLog,
      `Increased backtick count for O.${pairId} to ${required}`,
    ],
  };
}

function applyConvertTilde(state: EditorState): EditorState {
  const newTokens = state.outputTokens.map((t) => {
    if (t.symbol === "tilde") {
      const updated = { ...t, symbol: "backtick" as const };
      return { ...updated, raw: rebuildRaw(updated) };
    }
    return { ...t };
  });

  return {
    ...state,
    outputTokens: newTokens,
    hasTilde: false,
    actionLog: [...state.actionLog, "Converted all tilde fences to backticks"],
  };
}

// ─── Output File Reconstruction ─────────────────────────────────

/**
 * Reconstruct the source text with outputTokens applied.
 * Iterates originalLines; if line number matches a token, replaces with token.raw.
 * Preserves ALL non-fence lines exactly.
 */
export function reconstructOutput(
  outputTokens: FenceToken[],
  originalLines: string[],
): string {
  const tokenMap = new Map<number, FenceToken>();
  for (const t of outputTokens) {
    tokenMap.set(t.line, t);
  }

  const result: string[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    const lineNum = i + 1;
    const token = tokenMap.get(lineNum);
    if (token) {
      result.push(token.raw);
    } else {
      result.push(originalLines[i]);
    }
  }

  return result.join("\n");
}

/**
 * Backward-compatible wrapper: takes the full source string.
 */
export function reconstructSource(
  originalSource: string,
  outputTokens: FenceToken[],
): string {
  const lines = originalSource.split("\n");
  return reconstructOutput(outputTokens, lines);
}

// ─── Raw String Builder ─────────────────────────────────────────

/**
 * Rebuild the raw string representation of a fence token.
 */
function rebuildRaw(token: FenceToken): string {
  const sym = token.symbol === "backtick" ? "`" : "~";
  const fenceStr = sym.repeat(token.backtickCount);
  if (token.kind === "open" && token.infostring !== null) {
    return `${fenceStr}${token.infostring}`;
  }
  return fenceStr;
}

// ─── Pair Info ──────────────────────────────────────────────────

export interface FencePairInfo {
  id: number;
  open: FenceToken;
  close: FenceToken;
}

export function getOutputPairIds(tokens: FenceToken[]): number[] {
  const ids = new Set<number>();
  for (const t of tokens) {
    if (t.pairId > 0) ids.add(t.pairId);
  }
  return [...ids].sort((a, b) => a - b);
}

export function getOutputPairs(tokens: FenceToken[]): FencePairInfo[] {
  const pairs: FencePairInfo[] = [];
  const ids = getOutputPairIds(tokens);
  for (const id of ids) {
    const opens = tokens.filter((t) => t.pairId === id && t.kind === "open");
    const closes = tokens.filter((t) => t.pairId === id && t.kind === "close");
    if (opens.length > 0 && closes.length > 0) {
      pairs.push({ id, open: opens[0], close: closes[0] });
    }
  }
  return pairs;
}

// ─── Auto-Adjust Backticks ──────────────────────────────────────

/**
 * Auto-adjust fence counts to satisfy the nesting rule:
 * outer fence backtickCount must be >= inner fence backtickCount + 1.
 *
 * Applies per symbol type: only adjusts when both outer and inner use
 * the same symbol (backtick-backtick or tilde-tilde). Does not mix symbols.
 *
 * Regenerates raw strings for ALL tokens after adjustment.
 */
export function autoAdjustBackticks(tokens: FenceToken[]): FenceToken[] {
  const result = tokens.map((t) => ({ ...t }));
  const pairs = getOutputPairs(result);

  for (const outer of pairs) {
    for (const inner of pairs) {
      if (inner.id === outer.id) continue;
      // Only adjust within the same symbol type
      if (inner.open.symbol !== outer.open.symbol) continue;

      if (
        inner.open.line > outer.open.line &&
        inner.close.line < outer.close.line
      ) {
        const minOuter = inner.open.backtickCount + 1;
        if (outer.open.backtickCount < minOuter) {
          const diff = minOuter - outer.open.backtickCount;
          for (let i = 0; i < result.length; i++) {
            if (result[i].pairId === outer.id) {
              result[i].backtickCount += diff;
            }
          }
        }
      }
    }
  }

  // Regenerate raw strings
  for (let i = 0; i < result.length; i++) {
    result[i] = {
      ...result[i],
      raw: rebuildRaw(result[i]),
    };
  }

  return result;
}
