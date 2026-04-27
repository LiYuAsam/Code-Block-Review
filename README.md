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
- Always-on automatic capture for AI/tool-like large edits, multi-file edits, and bursty edit sessions
- Block-based review instead of file-only diff review
- Explorer sidebar that groups pending changes by file and block, with quick access to the review panel
- Distinct editor highlights for added, modified, deleted, and currently selected review blocks; modified blocks use blue styling
- Optional inline block badges for `ADDED`, `REPLACED`, and `DELETED` changes
- Token-level difference highlighting for replaced blocks inside the review panel
- Deleted blocks show a red inline summary at the deletion point, with full baseline code available in hover and the review panel
- Fully deleted files open a read-only baseline preview with red deleted-file styling
- Editor-first CodeLens review actions under each pending block:
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
- File-level and all-files Accept / Reject actions only handle remaining pending blocks, so already handled blocks stay unchanged
- Scoped auto-capture baselines for large workspaces: entire workspace, active project, or recently touched projects
- Large Ready sessions warn when they keep significant review text or baseline snapshots around
- Capture / Ready sessions are released when the underlying Git HEAD/ref changes, avoiding stale reviews after branch switches
- Localized settings, command titles, status bar text, notifications, Explorer tree text, and CodeLens labels based on the VS Code/Cursor display language
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
- the default Ready wait time is 120 seconds
- set `codexReview.autoCapture.reviewOfferSeconds` to `0` to keep Ready sessions waiting indefinitely until you review or skip them manually
- large Ready sessions show a warning if they hold many pending blocks, review text, or baseline snapshots
- if Git HEAD/ref changes during capture or Ready, the session is released and the extension returns to Auto Armed

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
- `autoCapture.scope`
  Controls how much of a large workspace is scanned into the baseline. The default `touchedProjects` covers the active project and recently touched project roots while avoiding old untouched files becoming review candidates.
- `autoCapture.projectRootMarkers`
  Helps detect subproject roots. Defaults include common markers such as `package.json`, `go.mod`, `pom.xml`, `Cargo.toml`, and `.git`.

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
- optional scoped auto-capture baselines for large multi-project workspaces
- idle timing before review becomes available
- review offer timeout, defaulting to 120 seconds; `codexReview.autoCapture.reviewOfferSeconds = 0` disables auto-dismiss and keeps the current review session in memory until handled
- burst-detection thresholds
- profiler diagnostic logging

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
