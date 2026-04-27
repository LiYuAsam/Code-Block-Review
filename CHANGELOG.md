# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0

- Highlight token-level differences in the review panel comparison for replaced code blocks
- Limit file-level and all-files Accept/Reject actions to the remaining pending blocks so previously handled blocks stay unchanged
- Use blue editor highlights and badges for modified blocks so additions, replacements, deletions, and the current review block are easier to distinguish
- Allow `codexReview.autoCapture.reviewOfferSeconds` to be set to `0` so Ready auto-capture sessions wait indefinitely for manual review or skip
- Increase the default Ready auto-capture review offer timeout from 60 seconds to 120 seconds
- Warn when an auto-capture Ready session is large enough to keep significant review text or baseline snapshots around
- Automatically release auto-capture Ready sessions when refreshed diffs no longer contain pending review blocks
- Release capture/Ready sessions when the underlying Git repository HEAD/ref changes, avoiding stale reviews after branch switches or similar destructive Git operations
- Localize extension settings, commands, status bar text, review prompts, Explorer tree text, and CodeLens labels based on the current VS Code/Cursor display language
- 🎉 Mark this release as the first feature-complete preview after stabilizing automatic capture, scoped workspace baselines, deleted-file reviews, and block-level accept/reject flows

## 0.0.10

- Fix deleted files being misclassified as one-line replacements, which prevented opening the deleted-file baseline preview
- Treat empty current file content as zero lines during diffing so whole-file deletions are detected as deletions
- Keep deleted-file reviews on the read-only baseline preview path instead of attempting to open files that no longer exist
- Split ReviewController UI-facing behavior into focused controller modules for review panels, decorations, deleted-file previews, and status bar updates
- Move UI implementation helpers into `src/ui`, including review panel rendering, Explorer tree/CodeLens providers, and editor decoration definitions

## 0.0.9

- Avoid treating old files from newly expanded scoped workspace roots as new pending files during auto capture

## 0.0.8

- Reduced typing overhead by avoiding blocking auto-capture baseline work during normal edits
- Debounced review-mode document diff refreshes to reduce lag while editing inside an active review
- Added optional scoped auto-capture baseline settings for large multi-project workspaces
- Ignored likely save-triggered formatter or ESLint autofix edits during idle auto-capture
- Show auto-capture baseline syncing/ready/failed state in the status bar
- Reuse unchanged auto-capture baseline snapshots so refreshes only rewrite changed files
- Show incremental baseline updates after idle manual edits are absorbed
- Restore inline Accept/Reject actions in deleted-file baseline previews
- Refresh Explorer review tree nodes from current review data after inline actions
- Close deleted-file baseline preview tabs after accepting or rejecting their block

## 0.0.7

- Improved large-file block detection so distant hunks are not collapsed into one giant review block
- Added a `codexReview.showBlockBadges` setting, disabled by default, for inline block labels
- Show a red inline summary for deleted blocks at the deletion location, with full baseline code available in hover and the review panel
- Open a read-only deleted-file baseline preview with red deleted-file styling when reviewing blocks from files that no longer exist
- Increased the contrast of the currently selected review block highlight

## 0.0.6

- Fixed rejecting newly created files so they are deleted instead of being left behind as empty files

## 0.0.5

- Significantly reduced memory and CPU overhead
- Reduced auto-capture review startup cost by reusing a clean final workspace diff pass when entering review
- Coalesced overlapping full-workspace scans to avoid duplicate CPU-heavy refresh work
- Optimized reject flows to refresh the changed file instead of rescanning the whole workspace
- Reused auto-capture baseline snapshots when starting automatic sessions to avoid unnecessary baseline copy work
- Skipped generated and dependency directories earlier in file watching and review tracking
- Added a `codexReview.profiler.enabled` setting so profiler Output Channel logging is disabled by default
- Trimmed large inline hover previews while keeping full block content available in the review panel

## 0.0.4

- Added clearer in-editor review actions with `Accept`, `Reject`, `Prev Block`, `Next Block`, and `Review`
- Kept inline `ADDED` / `REPLACED` / `DELETED` badges while refining the editor-first review flow
- Changed the auto-capture review prompt so `Start Review` jumps to the first pending block instead of forcing the side panel
- Refreshed the English and Chinese README to match the latest review workflow

## 0.0.3

- Refined auto-capture heuristics so rapid edit events only act as an assist signal instead of a standalone trigger
- Removed temporary event-debug output and cleaned up related commands
- Expanded the English and Chinese README with a clearer explanation of auto-capture behavior

## 0.0.2

- Refined automatic capture defaults to reduce false positives during manual editing
- Updated branding and Marketplace-facing metadata for the public release flow
- Added packaged extension icon and refreshed documentation

## 0.0.1

- Initial private release of Code Block Review
- Manual review sessions with block-level accept and reject
- Auto capture for bursty multi-file edit sessions
- Explorer view and dedicated review panel
- Configurable ignored file globs
