# Code Block Review

A VS Code extension for reviewing AI-assisted and manual code changes in block-based review sessions.

## What It Does

Code Block Review adds a review layer on top of your working tree so you can inspect changes as structured blocks instead of raw file diffs.

It is designed for:

- AI-generated edits
- tool-generated edits
- manual follow-up edits
- mixed sessions where AI and human changes happen together

## Current Features

- Manual review sessions with `Start Review Session`
- Automatic capture for large or bursty edit sessions
- Inline block highlighting for added, deleted, and replaced code
- Explorer sidebar that groups pending changes by file and block
- Dedicated review panel with:
  - previous / next block navigation
  - accept / reject block
  - accept / reject current file
  - accept / reject all remaining files
- Review sessions that continue to absorb new edits while the session is still active
- Configurable ignored file globs for lockfiles, snapshots, and generated files

## How It Works

### Manual flow

1. Run `Code Block Review: Start Review Session`
2. Make edits or let your AI tool edit code
3. Run `Code Block Review: Stop Capture And Review`
4. Review pending blocks from the Explorer view or review panel

### Automatic flow

When auto capture is enabled, the extension watches for bursty or large edits that look more like AI/tool output than ordinary typing.

After capture goes idle:

- the status bar switches to a `Ready` state
- you can jump directly into the review panel
- or let the session expire and silently merge into the new baseline

## Configuration

The extension currently supports:

- ignored file globs
- always-on auto capture
- baseline refresh triggers
- idle timing before review becomes available
- review offer timeout
- heuristic thresholds for burst detection

See the extension settings panel for the full list.

## Local Development

1. Open this folder in VS Code
2. Press `F5` to launch an Extension Development Host

Quick validation:

```bash
npm run check
```

## Project Status

This project is actively evolving. The current version is already usable, but the publishing metadata is still being finalized.

## Repository

- Issues: https://github.com/LiYuAsam/Code-Block-Review/issues
- Repository: https://github.com/LiYuAsam/Code-Block-Review
