/**
 * Unit tests for generateValidActions, applyAction, and pairFences.
 */

import { applyAction, autoAdjustBackticks, createEditorState, type EditorState, generateValidActions, getOutputPairs, hasCrossSymbolCrossing, pairFences, reconstructOutput } from "../src/model/state.ts";
import type { FenceToken } from "../src/model/fence.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

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
  const tokens = makeTokens([
    { line: 5, kind: "open" },
    { line: 8, kind: "open" },
    { line: 11, kind: "close" },
    { line: 14, kind: "close" },
  ]);
  const result = pairFences(tokens);
  assertEquals(result[0].kind, "open");
  assertEquals(result[0].pairId, 2);
  assertEquals(result[1].kind, "open");
  assertEquals(result[1].pairId, 1);
  assertEquals(result[2].kind, "close");
  assertEquals(result[2].pairId, 1);
  assertEquals(result[3].kind, "close");
  assertEquals(result[3].pairId, 2);
  assert(result.every((t) => t.pairId > 0), "All should be paired");
});

Deno.test("pairFences maintains separate stacks for backtick and tilde", () => {
  // Mixed fences: backticks and tildes must not cross-pair
  const tokens = makeTokens([
    { line: 1, symbol: "backtick" },
    { line: 3, symbol: "tilde" },
    { line: 5, symbol: "tilde" },
    { line: 7, symbol: "backtick" },
  ]);
  const result = pairFences(tokens);

  // Backtick pair: (1, 7)
  const btOpen = result.find((t) => t.symbol === "backtick" && t.kind === "open")!;
  const btClose = result.find((t) => t.symbol === "backtick" && t.kind === "close")!;
  assertEquals(btOpen.pairId, btClose.pairId, "Backticks should be paired together");
  assertEquals(btOpen.pairId, 1);

  // Tilde pair: (3, 5)
  const tdOpen = result.find((t) => t.symbol === "tilde" && t.kind === "open")!;
  const tdClose = result.find((t) => t.symbol === "tilde" && t.kind === "close")!;
  assertEquals(tdOpen.pairId, tdClose.pairId, "Tildes should be paired together");
  assertEquals(tdOpen.pairId, 2);
});

// ─── generateValidActions ───────────────────────────────────────

Deno.test("generateValidActions produces swap action for test/fixtures/00.md structure", () => {
  const tokens = makeTokens([
    { line: 5 },
    { line: 8 },
    { line: 11 },
    { line: 14 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const swapActions = actions.filter((a) => a.type === "restructure");
  assert(
    swapActions.length > 0,
    `Should have a swap action, got: ${JSON.stringify(actions.map((a) => a.label))}`,
  );

  const expected = swapActions.find(
    (a) =>
      a.pairId === 1 &&
      a.newCloseLine === 14 &&
      a.swapPairId === 2,
  );
  assert(
    expected,
    `Should have swap action: O.1 close from 8→14. Got: ${JSON.stringify(swapActions)}`,
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

Deno.test("generateValidActions has NO standalone increase-backtick action", () => {
  // Even with nesting violations, increase-backtick is not a separate action.
  // Auto-adjustment happens atomically on restructure or convert-tilde.
  const tokens = makeTokens([
    { line: 1, backtickCount: 3, infostring: "outer" },
    { line: 3, backtickCount: 3, infostring: "inner" },
    { line: 7, backtickCount: 3 },
    { line: 10, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);
  const actions = generateValidActions(state);

  // No action label should contain "Increase"
  const increaseLabels = actions.filter((a) => a.label.includes("Increase"));
  assertEquals(
    increaseLabels.length,
    0,
    `Should not have any increase action. Got: ${JSON.stringify(actions.map((a) => a.label))}`,
  );
});

// ─── Cross-Symbol Boundary Validation ───────────────────────────

Deno.test("hasCrossSymbolCrossing detects crossing ranges", () => {
  // Crossing: backtick (5,14), tilde (8,21) → tilde open inside backtick, close outside
  const crossing = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
    { line: 21, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
  ];
  assert(hasCrossSymbolCrossing(crossing), "Should detect crossing (5<8<14<21)");
});

Deno.test("hasCrossSymbolCrossing allows nested (non-crossing) ranges", () => {
  // Nested: backtick (5,14) contains tilde (8,11) → no crossing
  const nested = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 11, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
  ];
  assertEquals(hasCrossSymbolCrossing(nested), false, "Nested ranges should not be crossing");
});

Deno.test("hasCrossSymbolCrossing allows same-symbol crossing", () => {
  // Same-symbol crossing is NOT checked (same symbol pairs are never crossing by definition)
  const sameSymbol = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "```" },
    { line: 11, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "```" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
  ];
  assertEquals(hasCrossSymbolCrossing(sameSymbol), false, "Same-symbol pairs are never crossing");
});

Deno.test("test/fixtures/02.md: restructure blocked by cross-symbol boundary rule", () => {
  // O.1=(5,14) backtick, O.2=(8,11) tilde, O.3=(18,21) tilde
  // Swapping O.2↔O.3 would create tilde (8,21) crossing backtick (5,14)
  const tokens = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 11, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
    { line: 18, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 3, raw: "~~~" },
    { line: 21, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 3, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const restructureActions = actions.filter((a) => a.type === "restructure");

  assertEquals(
    restructureActions.length,
    0,
    `No restructure actions should appear when cross-symbol boundary would be violated. Got: ${JSON.stringify(actions.map((a) => a.label))}`,
  );

  // Only convert-tilde should be available
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Convert-tilde action should still be available");
});

Deno.test("test/fixtures/02.md: after convert-tilde, restructure suppressed for one frame", () => {
  // After converting tilde to backtick, all pairs are backticks.
  // However, restructure actions are suppressed for one frame to prevent
  // immediately suggesting merges of previously-separate blocks.
  const tokens = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 11, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
    { line: 18, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 3, raw: "~~~" },
    { line: 21, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 3, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  // Apply convert-tilde
  const convertAction = generateValidActions(state).find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde");

  const newState = applyAction(state, convertAction.id);

  // All symbols are now backtick
  assert(
    newState.outputTokens.every((t) => t.symbol === "backtick"),
    "All tokens should be backtick",
  );

  // After conversion, skipRestructure is set → no restructure actions
  assert(newState.skipRestructure, "skipRestructure should be true after conversion");

  const newActions = generateValidActions(newState);
  const restructureActions = newActions.filter((a) => a.type === "restructure");

  assertEquals(
    restructureActions.length,
    0,
    `No restructure actions should appear immediately after conversion. Got: ${JSON.stringify(newActions.map((a) => a.label))}`,
  );
});

Deno.test("test/fixtures/02.md: after restructure following conversion, restructure allowed again", () => {
  // After a restructure action is applied, skipRestructure is cleared.
  // Use test/fixtures/00.md pattern: two separate pairs (5,8) and (11,14).
  const tokens = makeTokens([
    { line: 5 },
    { line: 8 },
    { line: 11 },
    { line: 14 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  // Manually set skipRestructure to true (simulating post-conversion state)
  const skipState: EditorState = { ...state, skipRestructure: true };

  // No restructure actions when flag is set
  assertEquals(
    generateValidActions(skipState).filter((a) => a.type === "restructure").length,
    0,
    "Restructure should be suppressed when flag is set",
  );

  // Apply a restructure action from a state without the flag
  const actions = generateValidActions(state);
  const swapAction = actions.find((a) => a.type === "restructure" && a.swapPairId !== undefined);
  assert(swapAction, "Should have swap action in non-suppressed state");

  const newState = applyAction(state, swapAction.id);

  // Flag should be cleared
  assertEquals(newState.skipRestructure, false, "skipRestructure should be cleared after restructure");
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

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);

  const newPairs = getOutputPairs(newState.outputTokens);
  assertEquals(newPairs.length, 2, "Should still have 2 pairs");

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

  const outerToken = newState.outputTokens.find((t) => t.line === 5)!;
  assert(
    outerToken.raw.length >= 4,
    `Outer raw should have 4+ backticks, got: "${outerToken.raw}"`,
  );
});

Deno.test("applyAction convert-tilde is atomic with auto-adjustment", () => {
  // Nested pairs: backtick outer (5,14), tilde inner (8,11).
  // After conversion, inner becomes backtick and is nested inside outer.
  // Auto-adjustment should increment outer's count to 4.
  const tokens = makeTokens([
    { line: 5, backtickCount: 3, infostring: "outer" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null },
    { line: 11, backtickCount: 3, symbol: "tilde" as const },
    { line: 14, backtickCount: 3 },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");

  const newState = applyAction(state, convertAction.id);

  // All symbols should be backtick
  assert(
    newState.outputTokens.every((t) => t.symbol === "backtick"),
    "All tokens should be backtick after conversion",
  );

  // Find outer (5,14) and inner (8,11) — now both backtick
  const outer = newState.outputTokens.find((t) => t.line === 5)!;
  const inner = newState.outputTokens.find((t) => t.line === 8)!;

  // Outer should have been auto-adjusted to 4 (inner is 3, need >= 4)
  assertEquals(outer.backtickCount, 4, "Outer should be auto-adjusted to 4");
  assertEquals(inner.backtickCount, 3, "Inner should stay at 3");

  // Raw strings should reflect new counts
  assert(outer.raw.startsWith("````"), `Outer raw should start with \`\`\`\`, got: "${outer.raw}"`);
  assertEquals(newState.hasTilde, false, "hasTilde should be false");
});

Deno.test("applyAction convert-tilde works on test/fixtures/02.md-like structure", () => {
  // O.1=(5,14) backtick, O.2=(8,11) tilde, O.3=(18,21) tilde
  // After conversion: O.2 nested inside O.1, so O.1 count → 4
  const tokens = makeTokens([
    { line: 5, backtickCount: 3 },
    { line: 8, backtickCount: 3, symbol: "tilde" as const },
    { line: 11, backtickCount: 3, symbol: "tilde" as const },
    { line: 14, backtickCount: 3 },
    { line: 18, backtickCount: 3, symbol: "tilde" as const },
    { line: 21, backtickCount: 3, symbol: "tilde" as const },
  ]);
  const paired = pairFences(tokens);
  const state = createEditorState(paired);

  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");

  const newState = applyAction(state, convertAction.id);

  // O.1=(5,14) should have count 4 (O.2=(8,11) is nested inside)
  const outer = newState.outputTokens.find((t) => t.line === 5)!;
  assertEquals(outer.backtickCount, 4, "O.1 should be auto-adjusted to 4");

  // O.3=(18,21) should stay at 3 (not nested inside O.1)
  const o3open = newState.outputTokens.find((t) => t.line === 18)!;
  assertEquals(o3open.backtickCount, 3, "O.3 should stay at 3");

  // All symbols should be backtick
  assert(
    newState.outputTokens.every((t) => t.symbol === "backtick"),
    "All tokens should be backtick",
  );
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

Deno.test("autoAdjustBackticks adjusts tilde nesting too", () => {
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "tilde" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "~~~" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "~~~" },
  ];

  const adjusted = autoAdjustBackticks(tokens);
  const outer = adjusted.find((t) => t.pairId === 1 && t.kind === "open")!;
  const inner = adjusted.find((t) => t.pairId === 2 && t.kind === "open")!;

  assertEquals(outer.backtickCount, 4, "Outer tilde should be increased to 4");
  assertEquals(inner.backtickCount, 3, "Inner tilde should stay at 3");
  assert(outer.raw.startsWith("~~~~"), `Outer raw should start with ~~~~, got: "${outer.raw}"`);
});

Deno.test("autoAdjustBackticks does not cross-adjust between symbols", () => {
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "backtick" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "```" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
  ];

  const adjusted = autoAdjustBackticks(tokens);
  const outer = adjusted.find((t) => t.pairId === 1)!;

  assertEquals(outer.backtickCount, 3, "Outer backtick should stay at 3 (no cross-symbol adjustment)");
});
