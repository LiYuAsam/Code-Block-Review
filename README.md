# Code Block Review

English | [简体中文](./README.zh-CN.md)

Code Block Review is a VS Code extension that turns working tree changes into structured review sessions, so you can inspect edits as blocks instead of raw file diffs.

It works well for:

- AI-assisted edits
- tool-generated edits
- manual follow-up edits
- mixed sessions where AI and human changes happen together

## Why It Exists

Modern coding tools can change multiple files quickly, but the resulting edits often land in the working tree as ordinary file modifications. That makes review harder than it should be.

Code Block Review adds a lightweight review layer on top of your workspace:

- group changes into a review session
- highlight added, deleted, and replaced blocks inline
- review by block, file, or all remaining files
- keep new edits inside the same session while review is still active

## Features

- Manual review sessions with `Code Block Review: Start Review Session`
- Automatic capture for large or bursty edit sessions
- Block-based review instead of file-only diff review
- Explorer sidebar that groups pending changes by file and block
- Optional inline block badges for `ADDED`, `REPLACED`, and `DELETED` changes
- Deleted blocks show a red inline summary at the deletion point, with full baseline code available in hover and the review panel
- Fully deleted files open a read-only baseline preview with red deleted-file styling
- Editor-first review actions under each pending block:
  - `Accept`
  - `Reject`
  - `Prev Block`
  - `Next Block`
  - `Review`
- Dedicated review panel with:
  - previous / next navigation
  - accept / reject block
  - accept / reject current file
  - accept / reject all remaining files
- Ignore rules for lockfiles, generated files, snapshots, and other noisy outputs

## Demo

Try the live demo here: [code-block-review-demo.html](https://liyuasam.github.io/Code-Block-Review/code-block-review-demo.html).

The source file is also included in this repo if you want to inspect or update it locally.

## How It Works

### Manual flow

1. Run `Code Block Review: Start Review Session`
2. Make edits or let your AI tool edit code
3. Run `Code Block Review: Stop Capture And Review`
4. Review pending blocks directly in the editor, from the Explorer view, or in the review panel

### In-editor review flow

Each pending block is highlighted inline and gets a compact action row under the code block:

- `Accept` keeps the current block and jumps to the next pending block
- `Reject` restores the baseline version and jumps to the next pending block
- `Prev Block` / `Next Block` move between pending blocks without leaving the editor
- `Review` opens the dedicated side panel for a larger block-by-block comparison

### Automatic flow

When auto capture is enabled, the extension watches for edit bursts that look more like AI or tool output than ordinary typing.

After capture goes idle:

- the status bar switches to a `Ready` state
- the notification action starts review and jumps to the first pending block
- you can still open the dedicated review panel at any time
- or let the session expire and silently merge into the new baseline

### Auto-capture heuristics

Auto capture uses a short observation window instead of trying to classify every single edit event in isolation.

- `observationWindowSeconds`
  Controls how long the extension watches the first burst of edits before deciding.
- `largeChangeLines` / `largeChangeChars`
  A single large edit can trigger capture immediately.
- `multiFileMinFiles` + `multiFileMinLines`
  Cross-file edits are treated as more suspicious than ordinary typing.
- `burstMinLines`
  Counts unique touched lines inside the observation window, so repeated edits on the same line do not keep inflating the score.
- `burstEventWindowMilliseconds` + `burstMinEvents`
  A rapid-event assist signal. High event density no longer triggers capture by itself; it only slightly relaxes nearby multi-file or burst-line thresholds.

In practice, the extension decides in this order:

| Situation | Main signal | Result |
| --- | --- | --- |
| One edit is already very large | `largeChangeLines` or `largeChangeChars` | Capture starts |
| Multiple files change together | `multiFileMinFiles` and `multiFileMinLines` | Capture starts |
| Many unique lines change inside the short window | `burstMinLines` | Capture starts |
| Edit events are extremely dense | `burstEventWindowMilliseconds` + `burstMinEvents` | Only assists the two rules above |

## Configuration

The extension currently supports configuration for:

- ignored file globs
- optional inline block badges
- always-on auto capture
- baseline refresh triggers
- idle timing before review becomes available
- review offer timeout
- burst-detection thresholds

Open the extension settings panel for the full list.

## Local Development

1. Open this folder in VS Code
2. Press `F5` to launch an Extension Development Host

Quick validation:

```bash
npm run check
```

## Status

Code Block Review is already usable and under active iteration. The current version focuses on making review sessions practical for real AI-assisted coding workflows.

## Links

- Repository: https://github.com/LiYuAsam/Code-Block-Review
- Issues: https://github.com/LiYuAsam/Code-Block-Review/issues
