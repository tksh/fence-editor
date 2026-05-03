/**
 * Unit tests for auto-detect and format-aware output path generation.
 */

import { generateDefaultOutputPath, parseArgs, resolveFormat } from "../src/args.ts";
import { assertEquals } from "@std/assert";

// ─── resolveFormat ───────────────────────────────────────────────

Deno.test("resolveFormat: explicit flag takes priority", () => {
  assertEquals(resolveFormat("notes.dj", "commonmark"), "commonmark");
  assertEquals(resolveFormat("notes.md", "djot"), "djot");
  assertEquals(resolveFormat(null, "djot"), "djot");
});

Deno.test("resolveFormat: auto-detects .dj as djot", () => {
  assertEquals(resolveFormat("test/fixtures/00.dj", undefined), "djot");
  assertEquals(resolveFormat("notes.dj", undefined), "djot");
});

Deno.test("resolveFormat: auto-detects .djt as djot", () => {
  assertEquals(resolveFormat("article.djt", undefined), "djot");
});

Deno.test("resolveFormat: auto-detects .md as commonmark", () => {
  assertEquals(resolveFormat("doc.md", undefined), "commonmark");
  assertEquals(resolveFormat("src/README.md", undefined), "commonmark");
});

Deno.test("resolveFormat: auto-detects .markdown as commonmark", () => {
  assertEquals(resolveFormat("README.markdown", undefined), "commonmark");
});

Deno.test("resolveFormat: auto-detects .mdx as commonmark", () => {
  assertEquals(resolveFormat("page.mdx", undefined), "commonmark");
});

Deno.test("resolveFormat: unknown extension falls back to commonmark", () => {
  assertEquals(resolveFormat("file.txt", undefined), "commonmark");
  assertEquals(resolveFormat("file.rst", undefined), "commonmark");
  assertEquals(resolveFormat("no-ext", undefined), "commonmark");
});

Deno.test("resolveFormat: stdin (null) falls back to commonmark", () => {
  assertEquals(resolveFormat(null, undefined), "commonmark");
});

// ─── generateDefaultOutputPath ───────────────────────────────────

Deno.test("generateDefaultOutputPath: .md input → .edits.md", () => {
  assertEquals(generateDefaultOutputPath("doc.md", "commonmark"), "doc.edits.md");
  assertEquals(
    generateDefaultOutputPath("src/guide.md", "commonmark"),
    "src/guide.edits.md",
  );
});

Deno.test("generateDefaultOutputPath: .dj input → .edits.dj", () => {
  assertEquals(generateDefaultOutputPath("notes.dj", "djot"), "notes.edits.dj");
  assertEquals(
    generateDefaultOutputPath("test/fixtures/00.dj", "djot"),
    "test/fixtures/00.edits.dj",
  );
});

Deno.test("generateDefaultOutputPath: stdin → edited_output.<ext>", () => {
  assertEquals(generateDefaultOutputPath(null, "commonmark"), "edited_output.md");
  assertEquals(generateDefaultOutputPath(null, "djot"), "edited_output.dj");
});

Deno.test("generateDefaultOutputPath: format-aware even with .md input overridden to djot", () => {
  assertEquals(
    generateDefaultOutputPath("doc.md", "djot"),
    "doc.edits.dj",
  );
});

Deno.test("generateDefaultOutputPath: handles complex paths", () => {
  assertEquals(
    generateDefaultOutputPath("/home/user/docs/readme.md", "commonmark"),
    "/home/user/docs/readme.edits.md",
  );
  assertEquals(
    generateDefaultOutputPath("relative/path/to/file.dj", "djot"),
    "relative/path/to/file.edits.dj",
  );
});

Deno.test("generateDefaultOutputPath: file with no extension", () => {
  assertEquals(generateDefaultOutputPath("Makefile", "commonmark"), "Makefile.edits.md");
  assertEquals(generateDefaultOutputPath("Makefile", "djot"), "Makefile.edits.dj");
});

// ─── parseArgs compatibility ────────────────────────────────────

Deno.test("parseArgs: --format sets explicitFormat", () => {
  const args = parseArgs(["input.md", "--format", "djot"]);
  assertEquals(args.explicitFormat, "djot");
  assertEquals(args.inputFile, "input.md");
});

Deno.test("parseArgs: no --format means explicitFormat is undefined", () => {
  const args = parseArgs(["input.dj"]);
  assertEquals(args.explicitFormat, undefined);
  assertEquals(args.inputFile, "input.dj");
});
