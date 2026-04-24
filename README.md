# fence-editor

Interactively edit code-fence pairs (```, ~~~) for unambiguous parsing in Markdown/Djot.

## What it does

fence-editor visualizes the pair structure of code fences in Markdown and Djot documents, allowing you to manually reorganize them. It's particularly useful for fixing ambiguous fence nesting in documents merged from multiple sources, such as AI chat logs. The tool supports both CommonMark (parsed with micromark) and Djot (parsed with djot.js).

## Installation

Run directly via JSR with Deno:

```sh
deno run --allow-read --allow-write jsr:@tksh/fence-editor input.md
```

Install globally:

```sh
deno install --allow-read --allow-write -g jsr:@tksh/fence-editor
```

## Usage

Edit a file:

```sh
fence-editor input.md
```

Read from stdin:

```sh
cat input.md | fence-editor
```

Specify format explicitly:

```sh
fence-editor input.md --format djot
```

## CLI Options

| Option                        | Description                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--format <commonmark\|djot>` | Set parser format (default: auto-detect from extension). Accepts only lowercase `commonmark` or `djot`; exits with an error otherwise. |
| `--version`                   | Show version information                                                                                                               |
| `-h, --help`                  | Show help                                                                                                                              |

## UI Overview

The interactive UI displays:

`````txt
Format: CommonMark

Legend:
  I. = fence pair id (input)
  O. = fence pair id (output)

Status:
| line | input                | I. | O. | output               |
|-----:|:---------------------|---:|---:|:---------------------|
|    5 | ```                  |  1 |  2 | ````                 |
|    8 | ```                  |  1 |  1 | ```                  |
|   11 | ```                  |  2 |  1 | ```                  |
|   14 | ```                  |  2 |  2 | ````                 |

  O.1: line 8 → line 11 (backtick, 3x)
  O.2: line 5 → line 14 (backtick, 4x)

Actions:
  [1] Change close fence for O.1 from line 8 to line 14 (auto-pairs O.2 to line 11)

  > Enter action # | 0 to exit & save | Ctrl+C to cancel
`````

- **I.** shows the pair IDs from the original parsed input (immutable)
- **O.** shows the current pair IDs after applying edits (live)
- **Actions** lists valid restructurings that produce a fully valid document-wide pairing
- Enter a number to apply an action, then press Enter
- Enter `0` to exit and proceed to the save menu
- Press `Ctrl+C` to cancel immediately without saving

## Saving Output

When you exit with `0`, you can choose from:

- **[1] Save as new file** — Prompts for a file path with a pre-filled default `{base}_edited.{md|dj}`
- **[2] Overwrite input file** — Overwrites the original file (not available for stdin input)
- **[3] Print to stdout** — Outputs the reconstructed document to stdout only (UI text goes to stderr, making this pipeline-safe)
- **[4] Save status table as Markdown file** — Saves an edit log to `{base}.edits.{md|dj}` (or `edited_output.edits.{md|dj}` for stdin input)
- **[0] Cancel** — Returns to the editor without saving, allowing you to apply more actions

## Edit Log Format

The `.edits.{md|dj}` file contains two sections:

- **`## Applied Actions`** — Lists executed actions in order (numbered: `1. label`, `2. label`, etc.)
- **`## Status Changes`** — Shows the initial status table, followed by each action with its resulting table (prefixed with `Done: N. label`)

This provides a complete audit trail of all fence edits applied to the document.

## Supported Formats

- **CommonMark** — Parsed with micromark
- **Djot** — Parsed with djot.js

The format is auto-detected from the file extension (`.md`, `.markdown`, `.mdx` → CommonMark; `.dj`, `.djt` → Djot). Use `--format` to override the auto-detection.

## Limitations

When code fences have no infostring, their intended nesting cannot be determined automatically by the parser. fence-editor shows the parser's interpretation and lets you manually reorganize pairs. Only actions that result in a fully valid pairing across the entire document are offered—each candidate is validated by simulating the result and re-running the pairing algorithm.

## License

MIT — see [LICENSE](./LICENSE)
