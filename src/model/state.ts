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
  /** Status history capturing table after each action */
  statusHistory: Array<{ actionLabel: string; table: string }>;
  /** Parser format used: "commonmark" or "djot" */
  format: "commonmark" | "djot";
  /** Suppress restructure actions for one frame after tilde conversion */
  skipRestructure: boolean;
}

export function createEditorState(
  tokens: FenceToken[],
  format: "commonmark" | "djot" = "commonmark",
): EditorState {
  const inputTokens = Object.freeze(tokens.map((t) => ({ ...t })));
  const outputTokens = tokens.map((t) => ({ ...t }));
  const hasTilde = tokens.some((t) => t.symbol === "tilde");
  const statusHistory = [{ actionLabel: "Initial", table: renderStatusTableAsMarkdown(tokens) }];
  return { inputTokens, outputTokens, hasTilde, actionLog: [], statusHistory, format, skipRestructure: false };
}

// ─── Pure Pairing Function ──────────────────────────────────────

/**
 * Pair fences using CommonMark/Djot rules:
 * - infostring present → forced open
 * - kind="open" (explicit) → forced open (enables swap validation)
 * - no infostring + not explicit open → shortest-match stack pairing
 * - backtick and tilde treated independently with separate stacks
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
        // Explicitly marked as close — try shortest-match with same-symbol stack
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
        } else {
          // No matching open on same-symbol stack → treat as open
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
          // No open to match → treat as open
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
  type: "restructure" | "convert-tilde";
  /** For restructure: the target pairId */
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

// ─── Cross-Symbol Boundary Validation ───────────────────────────

/**
 * Detect whether any two pairs of DIFFERENT symbol types have crossing
 * line ranges. A crossing occurs when one pair's open falls inside another
 * pair's range but its close falls outside:
 *
 *   (A.open < B.open < A.close < B.close) ||
 *   (B.open < A.open < B.close < A.close)
 *
 * Such structures are technically parseable (backtick/tilde are independent
 * namespaces) but produce ambiguous, unreadable source. The tool blocks
 * any restructure that would create them.
 */
export function hasCrossSymbolCrossing(tokens: FenceToken[]): boolean {
  const pairs = getOutputPairs(tokens);

  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const A = pairs[i];
      const B = pairs[j];

      // Only check pairs of different symbol types
      if (A.open.symbol === B.open.symbol) continue;

      const aOpen = A.open.line;
      const aClose = A.close.line;
      const bOpen = B.open.line;
      const bClose = B.close.line;

      // Detect crossing: one open inside, its close outside the other's range
      if (
        (aOpen < bOpen && bOpen < aClose && aClose < bClose) ||
        (bOpen < aOpen && aOpen < bClose && bClose < aClose)
      ) {
        return true;
      }
    }
  }

  return false;
}

// ─── Internal Helpers ───────────────────────────────────────────

function findTokenIdx(
  tokens: FenceToken[],
  line: number,
  symbol: FenceToken["symbol"],
): number {
  return tokens.findIndex((t) => t.line === line && t.symbol === symbol);
}

/**
 * Deep clone tokens. Each FenceToken is a fresh object with primitive
 * properties only — shallow spread is sufficient.
 */
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
  // Must be same symbol type — different symbol stacks are independent
  if (A.open.symbol !== B.open.symbol) return { valid: false };

  // A must come before B
  if (A.close.line >= B.open.line) return { valid: false };

  // Deep clone — no reference leaks
  const cloned = cloneTokens(tokens);

  // Find the 4 tokens by line+symbol (exact match, no ambiguity)
  const aOpenIdx = findTokenIdx(cloned, A.open.line, A.open.symbol);
  const aCloseIdx = findTokenIdx(cloned, A.close.line, A.close.symbol);
  const bOpenIdx = findTokenIdx(cloned, B.open.line, B.open.symbol);
  const bCloseIdx = findTokenIdx(cloned, B.close.line, B.close.symbol);

  if (aOpenIdx < 0 || aCloseIdx < 0 || bOpenIdx < 0 || bCloseIdx < 0) {
    return { valid: false };
  }

  // Apply the swap on the clone:
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
  // Reset pairIds for the other two (pairFences will reassign)
  cloned[aOpenIdx].pairId = 0;
  cloned[bCloseIdx].pairId = 0;

  // Run pairFences on the entire cloned document
  const paired = pairFences(cloned);

  // ── FULL-DOCUMENT VALIDATION ──
  // Zero orphans allowed across the ENTIRE document, not just modified pairs.
  if (paired.some((t) => t.pairId === 0)) return { valid: false };

  // Cross-symbol boundary rule: no pair of one symbol type may span
  // across the open→close range of a pair of a different symbol type.
  if (hasCrossSymbolCrossing(paired)) return { valid: false };

  // Resulting pairing structure must differ from current state (no-op filter)
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

  // Run pairFences on the ENTIRE cloned document
  const paired = pairFences(cloned);

  // ── FULL-DOCUMENT VALIDATION ──
  // Zero orphans allowed across the ENTIRE document.
  if (paired.some((t) => t.pairId === 0)) return { valid: false };

  // Cross-symbol boundary rule
  if (hasCrossSymbolCrossing(paired)) return { valid: false };

  // Structure must differ (no-op filter)
  const currentStructure = getPairingStructure(tokens);
  const newStructure = getPairingStructure(paired);
  if (structuresEqual(currentStructure, newStructure)) return { valid: false };

  return { valid: true, paired };
}

// ─── Action Generation with Pairing Simulation ──────────────────

/**
 * Generate all valid actions from the current state.
 *
 * Restructure actions are validated by running pairFences on a clone
 * of the ENTIRE document. An action is valid ONLY if:
 * - pairFences on the cloned tokens produces ZERO orphans
 *   (every token has pairId > 0, not just the modified pairs)
 * - The resulting pairing structure differs from the current state
 *
 * Tilde-to-backtick conversion is always valid (when tilde exists)
 * and includes atomic auto-adjustment of nesting counts.
 */
export function generateValidActions(state: EditorState): Action[] {
  const actions: Action[] = [];
  const tokens = state.outputTokens;
  const pairs = getOutputPairs(tokens);

  // After tilde conversion, suppress restructure actions for one frame.
  // This prevents the UI from immediately suggesting merges of blocks that
  // were previously separate symbol types (and were not intended to be merged).
  const allowRestructure = !state.skipRestructure;

  // 1. Pairwise close-swap: for each pair of pairs (A, B) where A comes before B
  if (allowRestructure) {
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
  }

  // 2. Single close change (fallback): move one pair's close to an unpaired token
  if (allowRestructure) {
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
  }

  // 3. Convert tilde to backticks — ATOMIC: includes auto-adjustment
  //    No standalone "increase count" action needed; auto-adjust runs after conversion.
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

  let newState: EditorState;
  switch (action.type) {
    case "restructure":
      newState = applyRestructure(state, action);
      break;
    case "convert-tilde":
      newState = applyConvertTilde(state);
      break;
    default:
      return state;
  }

  // Capture status table after applying the action
  const table = renderStatusTableAsMarkdown(newState.outputTokens);
  newState.statusHistory = [
    ...state.statusHistory,
    { actionLabel: action.label, table },
  ];

  return newState;
}

/**
 * Apply a restructure action (swap or single-change).
 *
 * For swap actions: modifies both pairs' open/close tokens, runs pairFences,
 * auto-adjusts counts, and regenerates raw strings.
 *
 * For single-change actions: promotes old close to open, sets new close,
 * runs pairFences, auto-adjusts counts, and regenerates raw strings.
 */
function applyRestructure(state: EditorState, action: Action): EditorState {
  const { pairId, newCloseLine, swapPairId } = action;
  if (pairId === undefined || newCloseLine === undefined) return state;

  const tokens = state.outputTokens;
  const pairs = getOutputPairs(tokens);
  const A = pairs.find((p) => p.id === pairId);
  if (!A) return state;

  // Deep clone — no reference leaks
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

  // Re-pair ALL tokens in the document (pure function)
  const paired = pairFences(cloned);

  // Auto-adjust nesting counts (per symbol type)
  const adjusted = autoAdjustBackticks(paired);

  return {
    ...state,
    outputTokens: adjusted,
    actionLog: [...state.actionLog, action.label],
    skipRestructure: false,
  };
}

/**
 * Atomic tilde-to-backtick conversion with auto-adjustment.
 *
 * 1. Change symbol: tilde → backtick for all matching tokens.
 * 2. Regenerate raw strings.
 * 3. Run autoAdjustBackticks to enforce outer >= inner + 1 for all
 *    nested backtick pairs (including newly converted ones).
 * 4. Regenerate raw strings again after count adjustments.
 *
 * This makes the conversion atomic — the resulting state always has
 * valid nesting counts. No separate "increase count" step is needed.
 */
function applyConvertTilde(state: EditorState): EditorState {
  // Step 1: Convert symbols, regenerate raw
  const converted = state.outputTokens.map((t) => {
    if (t.symbol === "tilde") {
      const updated = { ...t, symbol: "backtick" as const };
      return { ...updated, raw: rebuildRaw(updated) };
    }
    return { ...t };
  });

  // Step 2: Auto-adjust nesting counts for all backtick pairs
  //         (now includes newly converted fences)
  const adjusted = autoAdjustBackticks(converted);

  return {
    ...state,
    outputTokens: adjusted,
    hasTilde: false,
    skipRestructure: true,
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

// ─── Auto-Adjust Nesting Counts ─────────────────────────────────

/**
 * Auto-adjust fence counts to satisfy the nesting rule:
 * outer fence backtickCount must be >= inner fence backtickCount + 1.
 *
 * Applies per symbol type: only adjusts when both outer and inner use
 * the same symbol (backtick-backtick or tilde-tilde). Does not mix symbols.
 *
 * Increments counts minimally, then regenerates raw strings for ALL tokens.
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

  // Regenerate raw strings for ALL tokens after count adjustments
  for (let i = 0; i < result.length; i++) {
    result[i] = {
      ...result[i],
      raw: rebuildRaw(result[i]),
    };
  }

  return result;
}

/**
 * Render the status table as a Markdown string for export.
 * This includes the initial table and each action's resulting table.
 * Backtick characters in table cells are escaped as HTML entities.
 */
function renderStatusTableAsMarkdown(tokens: FenceToken[]): string {
  const escaped = (s: string) => s.replace(/`/g, '&#96;');
  const lines: string[] = [];

  lines.push('| line | input                | I. | O. | output               |');
  lines.push('|-----:|:---------------------|---:|---:|:---------------------|');

  const tokenMap = new Map<number, FenceToken>();
  for (const t of tokens) {
    tokenMap.set(t.line, t);
  }

  const allLines = [...new Set(tokens.map((t) => t.line))].sort((a, b) => a - b);

  for (const lineNum of allLines) {
    const token = tokenMap.get(lineNum);
    const lineStr = String(lineNum);
    const inputRaw = token ? escaped(token.raw) : '';
    const inputId = token && token.pairId > 0 ? String(token.pairId) : '';
    const outputId = token && token.pairId > 0 ? String(token.pairId) : '';
    const outputRaw = token ? escaped(token.raw) : '';

    lines.push(
      `| ${lineStr.padStart(4)} | ${inputRaw.padEnd(20)} | ${inputId.padStart(2)} | ${outputId.padStart(2)} | ${outputRaw.padEnd(20)} |`,
    );
  }

  return lines.join('\n');
}
