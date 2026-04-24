# Changelog

All notable changes to this project will be documented in this file.

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
