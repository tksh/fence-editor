/**
 * Unit tests for generateValidActions, applyAction, and pairFences.
 */

import {
  createEditorState,
  generateValidActions,
  applyAction,
  pairFences,
  reconstructOutput,
  getOutputPairs,
  autoAdjustBackticks,
  type EditorState,
} from "../src/model/state.ts";
import type { FenceToken } from "../src/model/fence.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Helper: create tokens manually (bypassing parser)
// Defaults mimic the parser: infostring → "open", no infostring → "close"
function makeTokens(tokens: Partial<FenceToken>[]): FenceToken[] {
  return tokens.map((t, i) => {
    const hasInfostring = t.infostring !== undefined && t.infostring !== null;
    const kind = t.kind ?? (hasInfostring ? "open" : "close") as "open" | "close";
    return {
      line: t.line ?? i + 1,
      raw: t.raw ?? "```",
      backtickCount: t.backtickCount ?? 3,
      symbol: t.symbol ?? "backtick",
      infostring: t.infostring ?? null,
      kind,
      pairId: t.pairId ?? 0,
    };
  });
}

// ─── pairFences ─────────────────────────────────────────────────

Deno.test("pairFences pairs infostring fences as forced opens", () => {
  const tokens = makeTokens([
    { line: 1, infostring: "js" },
    { line: 5 },
  ]);
  const result = pairFences(tokens);
  assertEquals(result[0].kind, "open");
  assertEquals(result[0].pairId, 1);
  assertEquals(result[1].kind, "close");
  assertEquals(result[1].pairId, 1);
});

Deno.test("pairFences returns all paired when valid", () => {
  const tokens = makeTokens([
    { line: 1, infostring: "js" },
    { line: 5 },
    { line: 10, infostring: "python" },
    { line: 15 },
  ]);
  const result = pairFences(tokens);
  const allPaired = result.every((t) => t.pairId > 0);
  assert(allPaired, "All tokens should be paired");
});

Deno.test("pairFences leaves orphans when count is odd", () => {
  const tokens = makeTokens([
    { line: 1, infostring: "js" },
    { line: 5 },
    { line: 10 }, // extra orphan
  ]);
  const result = pairFences(tokens);
  const hasOrphan = result.some((t) => t.pairId === 0);
  assert(hasOrphan, "Should have an orphan token");
});

Deno.test("pairFences respects explicit kind='open' as forced open", () => {
  // This is the key fix: a token with kind="open" but no infostring
  // should be treated as forced open (not ambiguous).
  const tokens = makeTokens([
    { line: 5, kind: "open" },
    { line: 8, kind: "open" },
    { line: 11, kind: "close" },
    { line: 14, kind: "close" },
  ]);
  const result = pairFences(tokens);
  // 5→open, 8→open, 11 closes 8, 14 closes 5
  assertEquals(result[0].kind, "open"); // 5 stays open
  assertEquals(result[0].pairId, 2); // paired with 14
  assertEquals(result[1].kind, "open"); // 8 stays open
  assertEquals(result[1].pairId, 1); // paired with 11
  assertEquals(result[2].kind, "close"); // 11 closes 8
  assertEquals(result[2].pairId, 1);
  assertEquals(result[3].kind, "close"); // 14 closes 5
  assertEquals(result[3].pairId, 2);
  assert(result.every((t) => t.pairId > 0), "All should be paired");
});

// ─── generateValidActions ───────────────────────────────────────

Deno.test("generateValidActions produces swap action for test/00.md structure", () => {
  // Exact structure of test/00.md: 4 fences at lines 5, 8, 11, 14
  // all backtick, all no infostring.
  // Current LIFO pairing: O.1=(5,8), O.2=(11,14)
  // Desired: O.1=(5,14) outer, O.2=(8,11) inner
  const tokens = makeTokens([
    { line: 5 },
    { line: 8 },
    { line: 11 },
    { line: 14 },
  ]);
  const paired = pairFences(tokens);

  // Verify initial pairing
  assertEquals(paired[0].pairId, 1);
  assertEquals(paired[1].pairId, 1);
  assertEquals(paired[2].pairId, 2);
  assertEquals(paired[3].pairId, 2);

  const state = createEditorState(paired);
  const actions = generateValidActions(state);

  const swapActions = actions.filter((a) => a.type === "restructure");
  assert(
    swapActions.length > 0,
    `Should have a swap action, got: ${JSON.stringify(actions.map((a) => a.label))}`,
  );

  // The expected action
  const expected = swapActions.find(
    (a) =>
      a.pairId === 1 &&
      a.newCloseLine === 14 &&
      a.swapPairId === 2,
  );
  assert(
    expected,
    `Should have swap action: O.1 close from 8→14 (auto-pairs O.2 to 11). Got: ${JSON.stringify(swapActions)}`,
  );
  assertEquals(
    expected.label,
    "Change close fence for O.1 from line 8 to line 14 (auto-pairs O.2 to line 11)",
  );
});

Deno.test("generateValidActions produces no actions when single pair", () => {
  const tokens = makeTokens([
    { line: 1, infostring: "js" },
    { line: 5 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);
  const actions = generateValidActions(state);
  assertEquals(actions.length, 0, "No actions should be available");
});

Deno.test("generateValidActions produces convert-tilde when tilde exists", () => {
  const tokens = makeTokens([
    { line: 1, symbol: "tilde", infostring: "js" },
    { line: 5, symbol: "tilde" },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);
  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");
});

Deno.test("generateValidActions produces increase-backtick on nesting violation", () => {
  // Nested pairs with same backtick count
  const tokens = makeTokens([
    { line: 1, backtickCount: 3, infostring: "outer" },
    { line: 3, backtickCount: 3, infostring: "inner" },
    { line: 7, backtickCount: 3 },
    { line: 10, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);
  const actions = generateValidActions(state);
  const increaseAction = actions.find((a) => a.type === "increase-backtick");
  assert(increaseAction, "Should have increase-backtick action");
});

// ─── applyAction ────────────────────────────────────────────────

Deno.test("applyAction swap changes pairing structure", () => {
  const tokens = makeTokens([
    { line: 5 },
    { line: 8 },
    { line: 11 },
    { line: 14 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  // Initial: (5,8), (11,14)
  const initialPairs = getOutputPairs(state.outputTokens);
  assertEquals(initialPairs.length, 2);
  assertEquals(initialPairs[0].open.line, 5);
  assertEquals(initialPairs[0].close.line, 8);
  assertEquals(initialPairs[1].open.line, 11);
  assertEquals(initialPairs[1].close.line, 14);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);

  // Verify state changed
  assert(
    newState.outputTokens !== state.outputTokens,
    "outputTokens should be new array",
  );
  assert(
    newState.actionLog.length > state.actionLog.length,
    "actionLog should grow",
  );

  // Verify pairing structure changed to nested
  const newPairs = getOutputPairs(newState.outputTokens);
  assertEquals(newPairs.length, 2, "Should still have 2 pairs");

  // Find the outer and inner pairs
  const outer = newPairs.find(
    (p) => p.open.line === 5 && p.close.line === 14,
  );
  const inner = newPairs.find(
    (p) => p.open.line === 8 && p.close.line === 11,
  );
  assert(outer, "Should have outer pair (5,14)");
  assert(inner, "Should have inner pair (8,11)");
});

Deno.test("applyAction swap auto-adjusts backtick counts", () => {
  const tokens = makeTokens([
    { line: 5, backtickCount: 3 },
    { line: 8, backtickCount: 3 },
    { line: 11, backtickCount: 3 },
    { line: 14, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);
  const newPairs = getOutputPairs(newState.outputTokens);

  // After nesting, outer (5,14) should have backtickCount >= inner.count + 1
  const outer = newPairs.find(
    (p) => p.open.line === 5 && p.close.line === 14,
  )!;
  const inner = newPairs.find(
    (p) => p.open.line === 8 && p.close.line === 11,
  )!;

  assert(
    outer.open.backtickCount >= inner.open.backtickCount + 1,
    `Outer backtickCount (${outer.open.backtickCount}) should be >= inner + 1 (${inner.open.backtickCount + 1})`,
  );
});

Deno.test("applyAction swap regenerates raw strings", () => {
  const tokens = makeTokens([
    { line: 5 },
    { line: 8 },
    { line: 11 },
    { line: 14 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);

  for (const t of newState.outputTokens) {
    assert(t.raw.length > 0, `raw should be non-empty, got token at line ${t.line}`);
  }

  // Outer pair's raw should reflect increased backtick count
  const outerToken = newState.outputTokens.find((t) => t.line === 5)!;
  assert(
    outerToken.raw.length >= 4,
    `Outer raw should have 4+ backticks, got: "${outerToken.raw}"`,
  );
});

Deno.test("applyAction increase-backtick updates count and raw", () => {
  const tokens = makeTokens([
    { line: 1, backtickCount: 3, infostring: "outer" },
    { line: 3, backtickCount: 3, infostring: "inner" },
    { line: 7, backtickCount: 3 },
    { line: 10, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const increaseAction = actions.find((a) => a.type === "increase-backtick");
  assert(increaseAction, "Should have increase-backtick action");

  const newState = applyAction(state, increaseAction.id);
  const outerTokens = newState.outputTokens.filter(
    (t) => t.pairId === increaseAction.pairId,
  );

  for (const t of outerTokens) {
    assert(
      t.backtickCount > 3,
      `Outer backtickCount should be > 3, got ${t.backtickCount}`,
    );
  }
});

Deno.test("applyAction convert-tilde changes symbol and raw", () => {
  const tokens = makeTokens([
    { line: 1, symbol: "tilde", infostring: "js" },
    { line: 5, symbol: "tilde" },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");

  const newState = applyAction(state, convertAction.id);

  assertEquals(newState.hasTilde, false);
  for (const t of newState.outputTokens) {
    assertEquals(t.symbol, "backtick");
    assert(t.raw.includes("`"), "raw should contain backticks");
  }
});

// ─── reconstructOutput ──────────────────────────────────────────

Deno.test("reconstructOutput replaces fence lines with token.raw", () => {
  const originalLines = [
    "# Title",
    "",
    "```",
    "code",
    "```",
    "",
    "text",
  ];
  const tokens: FenceToken[] = [
    {
      line: 3,
      raw: "```js",
      backtickCount: 3,
      symbol: "backtick",
      infostring: "js",
      kind: "open",
      pairId: 1,
    },
    {
      line: 5,
      raw: "```",
      backtickCount: 3,
      symbol: "backtick",
      infostring: null,
      kind: "close",
      pairId: 1,
    },
  ];

  const result = reconstructOutput(tokens, originalLines);
  const resultLines = result.split("\n");

  assertEquals(resultLines[0], "# Title");
  assertEquals(resultLines[2], "```js");
  assertEquals(resultLines[4], "```");
  assertEquals(resultLines[6], "text");
});

// ─── autoAdjustBackticks ────────────────────────────────────────

Deno.test("autoAdjustBackticks increases outer for nested pairs", () => {
  const tokens = makeTokens([
    { line: 1, backtickCount: 3, infostring: "outer" },
    { line: 3, backtickCount: 3, infostring: "inner" },
    { line: 7, backtickCount: 3 },
    { line: 10, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const adjusted = autoAdjustBackticks(paired);
  const pairs = getOutputPairs(adjusted);

  const outer = pairs.find((p) => p.open.line === 1)!;
  const inner = pairs.find((p) => p.open.line === 3)!;

  assert(outer.open.backtickCount >= 4, "Outer should have >= 4 backticks");
  assertEquals(inner.open.backtickCount, 3, "Inner should stay at 3");
});
