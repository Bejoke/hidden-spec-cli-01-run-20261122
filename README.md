# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bejoke/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bejoke/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

## What it does

Agent harnesses apply edits that models write, and models write them in four formats. `mend` reads all four to one written specification (SPEC.md in the competition kit) and applies them to the tree of text files rooted at the working directory:

- **Unified diffs** — sections with `diff --git` / `---` / `+++` headers and `@@` hunks. Wrong line numbers are tolerated: a hunk takes the occurrence nearest its header's line number. Creations, deletions and moves are supported; a move prints as one `R old -> new` line.
- **SEARCH/REPLACE blocks** — the Aider-style `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` form, with the file path on the nearest line above the block. An old block that matches more than once at its tier is `ambiguous`.
- **V4A patches** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` / `*** Update File:` / `*** End Patch`, with `@@` anchors and `*** End of File` chunks. Chunks apply in order from a cursor that moves past what each chunk wrote.
- **JSON tool calls** — one JSON array of edit objects, or JSON Lines with one edit object per line: `create`, `str_replace` and `insert`.

Every edit is found at the first of three matching tiers — exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed — so an edit still lands when the model drifted the whitespace or indentation. Context lines are written as the file's own matched lines, and at the third tier added lines are re-indented to the file's indentation. `--strict` tries the exact tier only.

Either every file changes or none does: a failed edit changes nothing, the edits after it still run so every failure is reported, and when any edit failed no file is written at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file; when omitted (or `-`) the patch is read from standard input. `--format` is one of `auto` (the default), `unified`, `search-replace`, `v4a` or `json`. `--check` does everything but write. Options and PATCH may come in any order; `--` ends the options. Node 22 or later, standard library only, nothing to install.

```sh
# Apply a diff to the current tree
node main.ts fix.diff

# Apply SEARCH/REPLACE blocks piped in from a model
cat patch.txt | node main.ts

# See what would change without writing anything
node main.ts --check fix.diff

# Exact matching only (no fuzzy tiers)
node main.ts --strict fix.diff
```

On success it prints one line per changed path in byte order — `A <path>` for a file that did not exist, `D <path>` for one that is gone, `M <path>` for one that changed, `R <old> -> <new>` for a move — then `ok: <n> files`, and exits 0. On failure it prints one `error: <code> <path>` line per failed edit and then `failed: <k> of <n> edits`, and exits 1. A usage error, an unreadable patch file, an undetected format or a parse error prints exactly one `error: ...` line and exits 2. Everything is printed to stdout; nothing goes to stderr. The run is deterministic: the same patch on the same tree always prints the same lines and writes the same bytes.

`runner.ts` beside `main.ts` is the kit's trial runner, kept as shipped: when `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it, and it runs the CLI on each of the trial's checks in a fresh directory and posts the exit code, stdout, and resulting files.

## Verification

Against the kit's public practice set (100 checks: 30 unified, 20 search-replace, 20 V4A, 15 JSON, 15 CLI), run with the kit's `check.ts` and `runner.ts` beside this `main.ts`:

```sh
node check.ts program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

The score is deterministic across runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kxzsynh9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
