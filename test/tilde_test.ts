/**
 * Test tilde fence actions: restructure, increase, and state mutation.
 */

import { parseCommonMark } from "../src/parser/commonmark.ts";
import {
  createEditorState,
  generateValidActions,
  applyAction,
  reconstructOutput,
  getOutputPairs,
  autoAdjustBackticks,
} from "../src/model/state.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Tilde-only test file ───────────────────────────────────────
// Lines:
//   1: ~~~js        (forced open)
//   3: ~~~          (close for pair 1 — line 3 is blank+tilde)
//   4: ~~~          (open for pair 2 — immediately follows)
//   6: ~~~          (close for pair 2)
// LIFO pairing: O.1=(1,3), O.2=(4,6)
// Swap should produce: O.1=(1,6) outer, O.2=(3,4) inner
const TILDE_SOURCE = `~~~js
outer content
~~~
~~~
inner content
~~~
end
`;

Deno.test("tilde: parse and verify initial pairing", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  assertEquals(tokens.length, 4, "Should have 4 fence tokens");
  assert(tokens.every((t) => t.symbol === "tilde"), "All should be tildes");

  const state = createEditorState(tokens);
  const pairs = getOutputPairs(state.outputTokens);
  assertEquals(pairs.length, 2, "Should have 2 pairs");

  // Verify LIFO pairing: (1,3) and (4,6)
  assertEquals(pairs[0].open.line, 1);
  assertEquals(pairs[0].close.line, 3);
  assertEquals(pairs[1].open.line, 4);
  assertEquals(pairs[1].close.line, 6);
});

Deno.test("tilde: generate restructure action (pairwise swap)", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have a swap action for tilde pairs");
  assert(
    swapAction.label.includes("line 6") && swapAction.label.includes("line 4"),
    `Swap label should reference moving close to line 6 (auto-pair to line 4), got: "${swapAction.label}"`,
  );
});

Deno.test("tilde: apply swap action mutates state correctly", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);

  // Verify pairs changed to nested structure
  const newPairs = getOutputPairs(newState.outputTokens);
  assertEquals(newPairs.length, 2);

  // Find outer (1,6) and inner (3,4)
  const outer = newPairs.find((p) => p.open.line === 1 && p.close.line === 6);
  const inner = newPairs.find((p) => p.open.line === 3 && p.close.line === 4);

  assert(outer, `Should have outer pair (1,6). Got: ${JSON.stringify(newPairs.map((p) => [p.open.line, p.close.line]))}`);
  assert(inner, `Should have inner pair (3,4). Got: ${JSON.stringify(newPairs.map((p) => [p.open.line, p.close.line]))}`);

  // Verify all tokens are still tilde (swap shouldn't change symbol)
  assert(
    newState.outputTokens.every((t) => t.symbol === "tilde"),
    "All tokens should remain tilde after swap",
  );

  // Verify raw strings are regenerated with tildes
  for (const t of newState.outputTokens) {
    assert(
      t.raw.startsWith("~"),
      `Token at line ${t.line} raw should start with ~, got: "${t.raw}"`,
    );
  }
});

Deno.test("tilde: reconstructOutput uses updated token.raw after swap", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);
  const originalLines = TILDE_SOURCE.split("\n");
  const output = reconstructOutput(newState.outputTokens, originalLines);
  const outputLines = output.split("\n");

  // After swap + auto-adjust:
  // Line 1: outer open → ~~~~js (4 tildes, auto-adjusted for nesting)
  // Line 3: inner open → ~~~ (3 tildes)
  // Line 4: inner close → ~~~ (3 tildes)
  // Line 6: outer close → ~~~~ (4 tildes, auto-adjusted)
  const line1Token = newState.outputTokens.find((t) => t.line === 1)!;
  const line3Token = newState.outputTokens.find((t) => t.line === 3)!;
  const line4Token = newState.outputTokens.find((t) => t.line === 4)!;
  const line6Token = newState.outputTokens.find((t) => t.line === 6)!;

  assertEquals(outputLines[0], line1Token.raw, "Line 1 should use updated raw");
  assertEquals(outputLines[2], line3Token.raw, "Line 3 should use updated raw");
  assertEquals(outputLines[3], line4Token.raw, "Line 4 should use updated raw");
  assertEquals(outputLines[5], line6Token.raw, "Line 6 should use updated raw");

  // Outer has 4 tildes (auto-adjustment for nesting)
  assertEquals(line1Token.backtickCount, 4, "Outer open should have 4 tildes");
  assertEquals(line6Token.backtickCount, 4, "Outer close should have 4 tildes");
  assert(line1Token.raw.startsWith("~~~~"), `Outer raw should start with ~~~~, got: "${line1Token.raw}"`);
  assert(line6Token.raw.startsWith("~~~~"), `Outer raw should start with ~~~~, got: "${line6Token.raw}"`);

  // Inner stays at 3
  assertEquals(line3Token.backtickCount, 3, "Inner open should stay at 3");
  assertEquals(line4Token.backtickCount, 3, "Inner close should stay at 3");

  // Non-fence lines preserved
  assertEquals(outputLines[1], "outer content");
  assertEquals(outputLines[4], "inner content");
  assertEquals(outputLines[6], "end");
});

Deno.test("tilde: autoAdjustBackticks works for tilde nesting", () => {
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
  assert(inner.raw.startsWith("~~~") && !inner.raw.startsWith("~~~~"), `Inner raw should be ~~~, got: "${inner.raw}"`);
});

Deno.test("tilde: generate increase action for nested tilde pairs", () => {
  // Manually create state with nested tilde pairs that have equal counts
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "tilde" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "~~~" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const increaseAction = actions.find((a) => a.type === "increase-backtick");

  assert(
    increaseAction,
    `Should have increase action for nested tilde pairs. Actions: ${JSON.stringify(actions.map((a) => a.label))}`,
  );
  assert(
    increaseAction.label.includes("tilde"),
    `Label should mention tilde, got: "${increaseAction.label}"`,
  );
});

Deno.test("tilde: apply increase action updates count and raw", () => {
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "tilde" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "~~~" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const increaseAction = actions.find((a) => a.type === "increase-backtick");
  assert(increaseAction, "Should have increase action");

  const newState = applyAction(state, increaseAction.id);
  const outerTokens = newState.outputTokens.filter((t) => t.pairId === 1);

  for (const t of outerTokens) {
    assertEquals(t.backtickCount, 4, `Outer token at line ${t.line} should have 4 tildes`);
    assert(t.raw.startsWith("~~~~"), `Raw should start with ~~~~, got: "${t.raw}"`);
  }

  // Inner tokens unchanged
  const innerTokens = newState.outputTokens.filter((t) => t.pairId === 2);
  for (const t of innerTokens) {
    assertEquals(t.backtickCount, 3, `Inner token at line ${t.line} should stay at 3`);
  }
});

Deno.test("tilde: mixed symbol types are not cross-adjusted", () => {
  // Outer = backtick, inner = tilde — should NOT trigger adjustment
  // (per SPEC: do not mix backtick/tilde counts)
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "backtick" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "```" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
  ];

  const adjusted = autoAdjustBackticks(tokens);
  const outer = adjusted.find((t) => t.pairId === 1)!;

  // Should NOT be adjusted because inner is tilde, not backtick
  assertEquals(outer.backtickCount, 3, "Outer backtick count should stay at 3 (no cross-symbol adjustment)");
});
