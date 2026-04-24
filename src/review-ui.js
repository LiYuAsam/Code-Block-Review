const vscode = require('vscode')

const { formatBlockLabel } = require('./review-model')
const MAX_INLINE_PREVIEW_CHARS = 4000

function getRangeForBlock(document, block) {
  if (document.lineCount === 0) {
    return null
  }

  if (block.modifiedEnd > block.modifiedStart) {
    const start = new vscode.Position(Math.min(block.modifiedStart, document.lineCount - 1), 0)
    const endLine = Math.min(block.modifiedEnd - 1, document.lineCount - 1)
    return new vscode.Range(start, document.lineAt(endLine).range.end)
  }

  const anchorLine = Math.min(block.modifiedStart, document.lineCount - 1)
  return document.lineAt(anchorLine).range
}

function createBlockTooltip(fileLabel, block) {
  const lines = [
    fileLabel,
    formatBlockLabel(block),
    `Type: ${block.changeKind}`,
    '',
    'Current',
    createInlinePreviewText(block.modifiedText, '(empty)'),
    '',
    'Baseline',
    createInlinePreviewText(block.originalText, '(empty)')
  ]
  return lines.join('\n')
}

function createDecorationOption(range, fileLabel, block, state) {
  return {
    range,
    hoverMessage: createHoverMessage(fileLabel, block, state),
    renderOptions: {
      before: {
        contentText: getBlockBadgeText(block, state),
        color: getBadgeForegroundColor(block, state),
        backgroundColor: getBadgeBackgroundColor(block, state),
        margin: '0 12px 0 0',
        fontWeight: '700',
        border: `1px solid ${getBadgeBorderColor(block, state)}`,
        borderRadius: '999px'
      }
    }
  }
}

function createHoverMessage(fileLabel, block, state) {
  const markdown = new vscode.MarkdownString(undefined, true)
  markdown.isTrusted = false
  markdown.appendMarkdown(`**${escapeMarkdown(fileLabel)}**  \n`)
  markdown.appendMarkdown(`**${escapeMarkdown(formatBlockLabel(block))}**  \n`)
  markdown.appendMarkdown(`State: \`${state}\`  \n`)
  markdown.appendMarkdown(`Type: \`${block.changeKind}\``)

  if (block.modifiedText) {
    markdown.appendMarkdown('\n\n**Current**\n')
    markdown.appendCodeblock(createInlinePreviewText(block.modifiedText), '')
  }

  if (block.originalText) {
    markdown.appendMarkdown('\n\n**Baseline**\n')
    markdown.appendCodeblock(createInlinePreviewText(block.originalText), '')
  }

  return markdown
}

function createInlinePreviewText(text, emptyText = '') {
  if (!text) {
    return emptyText
  }

  if (text.length <= MAX_INLINE_PREVIEW_CHARS) {
    return text
  }

  return `${text.slice(0, MAX_INLINE_PREVIEW_CHARS)}\n... truncated; open the review panel for the full block.`
}

function getBlockBadgeText(block, state) {
  if (state === 'accepted') {
    return ' KEPT '
  }

  if (block.changeKind === 'addition') {
    return ' ADDED '
  }

  if (block.changeKind === 'deletion') {
    return ' DELETED '
  }

  return ' REPLACED '
}

function getBadgeForegroundColor(block, state) {
  if (state === 'accepted') {
    return '#99f6e4'
  }

  if (block.changeKind === 'addition') {
    return '#bbf7d0'
  }

  if (block.changeKind === 'deletion') {
    return '#fecaca'
  }

  return '#bbf7d0'
}

function getBadgeBackgroundColor(block, state) {
  if (state === 'accepted') {
    return 'rgba(20, 184, 166, 0.22)'
  }

  if (block.changeKind === 'addition') {
    return 'rgba(22, 163, 74, 0.28)'
  }

  if (block.changeKind === 'deletion') {
    return 'rgba(220, 38, 38, 0.28)'
  }

  return 'rgba(22, 163, 74, 0.22)'
}

function getBadgeBorderColor(block, state) {
  if (state === 'accepted') {
    return 'rgba(94, 234, 212, 0.45)'
  }

  if (block.changeKind === 'addition') {
    return 'rgba(134, 239, 172, 0.55)'
  }

  if (block.changeKind === 'deletion') {
    return 'rgba(252, 165, 165, 0.55)'
  }

  return 'rgba(134, 239, 172, 0.55)'
}

function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&')
}

function getBottomActionCodeLensRange(document, block) {
  if (document.lineCount === 0) {
    return null
  }

  const preferredLine = block.modifiedEnd < document.lineCount
    ? block.modifiedEnd
    : Math.max(block.modifiedEnd - 1, 0)
  const line = clamp(preferredLine, 0, document.lineCount - 1)
  return new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0))
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function cloneBlockForPreview(blockInfo) {
  return {
    uri: blockInfo.uri,
    label: vscode.workspace.asRelativePath(blockInfo.uri, false),
    block: {
      ...blockInfo.block,
      originalLines: [...blockInfo.block.originalLines],
      modifiedLines: [...blockInfo.block.modifiedLines]
    }
  }
}

function formatLineSpan(startZeroBased, endExclusive) {
  const start = startZeroBased + 1
  const end = Math.max(start, endExclusive)
  return start === end ? `${start}` : `${start}-${end}`
}

function formatPanelChangeSummary(block) {
  if (block.changeKind === 'addition') {
    return `+ L${formatLineSpan(block.modifiedStart, block.modifiedEnd)}`
  }

  if (block.changeKind === 'deletion') {
    return `- L${formatLineSpan(block.originalStart, block.originalEnd)}`
  }

  if (block.changeKind === 'modification') {
    return `- L${formatLineSpan(block.originalStart, block.originalEnd)}\n+ L${formatLineSpan(block.modifiedStart, block.modifiedEnd)}`
  }

  return formatBlockLabel(block)
}

function createPanelChangeSummaryHtml(block) {
  const lines = formatPanelChangeSummary(block).split('\n')
  return lines.map((line) => {
    const tone = line.trim().startsWith('-') ? 'removed' : 'added'
    return `<span class="summary-line ${tone}">${escapeHtml(line)}</span>`
  }).join('')
}

function createReviewPanelHtml(previewData, isLiveBlock, navigation, newPendingCount = 0) {
  const { label, block } = previewData
  const headlineHtml = createPanelChangeSummaryHtml(block)
  const badge = getBlockBadgeText(block, isLiveBlock ? block.status : 'handled').trim()
  const statusLabel = isLiveBlock ? (block.status === 'accepted' ? 'Accepted' : 'Pending review') : 'Already handled'
  const currentText = block.modifiedText || '// No current content for this block.'
  const baselineText = block.originalText || '// No baseline content for this block.'
  const currentTitle = block.changeKind === 'deletion' ? 'Current Result' : 'Current Code'
  const baselineTitle = block.changeKind === 'addition' ? 'Baseline (empty)' : 'Removed / Baseline Code'
  const primaryActionDisabled = isLiveBlock ? '' : 'disabled'
  const fileActionDisabled = isLiveBlock ? '' : 'disabled'
  const previousDisabled = isLiveBlock && navigation.hasPrevious ? '' : 'disabled'
  const nextDisabled = isLiveBlock && navigation.hasNext ? '' : 'disabled'
  const progressLabel = navigation.total > 0
    ? `Block ${navigation.currentIndex} of ${navigation.total}`
    : 'No remaining pending blocks'
  const noticeHtml = newPendingCount > 0
    ? `<section class="notice">
        <span class="notice-dot"></span>
        <span>${escapeHtml(`${newPendingCount} new block${newPendingCount === 1 ? '' : 's'} detected in this session`)}</span>
      </section>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #111318;
      --panel: #171b22;
      --panel-2: #1d2330;
      --border: rgba(255, 255, 255, 0.08);
      --text: #edf2f7;
      --muted: #99a2b3;
      --green-bg: rgba(34, 197, 94, 0.12);
      --green-border: rgba(74, 222, 128, 0.45);
      --red-bg: rgba(239, 68, 68, 0.12);
      --red-border: rgba(252, 165, 165, 0.42);
      --accent: #60a5fa;
      --button: #263042;
      --button-hover: #344156;
      --button-danger: #552631;
      --button-danger-hover: #6c3340;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: linear-gradient(180deg, #10141b 0%, #0c1016 100%);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .shell {
      padding: 18px;
      display: grid;
      gap: 16px;
    }

    .header {
      display: grid;
      gap: 10px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(96, 165, 250, 0.10), rgba(96, 165, 250, 0.02));
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      color: #dbeafe;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }

    .status {
      color: var(--muted);
      font-size: 13px;
    }

    .title {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      letter-spacing: -0.02em;
    }

    .summary-line {
      display: inline-flex;
      align-items: center;
      font-size: 24px;
      font-weight: 800;
      line-height: 1.1;
    }

    .summary-line.added {
      color: #86efac;
    }

    .summary-line.removed {
      color: #fca5a5;
    }

    .path {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .global-actions {
      display: grid;
      gap: 10px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid rgba(250, 204, 21, 0.30);
      background: linear-gradient(180deg, rgba(250, 204, 21, 0.20), rgba(250, 204, 21, 0.08));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .global-actions-title {
      color: #fef3c7;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    .global-actions-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .stack {
      display: grid;
      gap: 14px;
    }

    .notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(250, 204, 21, 0.28);
      background: linear-gradient(180deg, rgba(250, 204, 21, 0.14), rgba(250, 204, 21, 0.05));
      color: #fde68a;
      font-size: 13px;
      font-weight: 700;
    }

    .notice-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #facc15;
      box-shadow: 0 0 0 4px rgba(250, 204, 21, 0.16);
      flex: 0 0 auto;
    }

    .block {
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--panel);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }

    .block.removed {
      border-color: var(--red-border);
      background: linear-gradient(180deg, rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.02));
    }

    .block.added {
      border-color: var(--green-border);
      background: linear-gradient(180deg, rgba(34, 197, 94, 0.08), rgba(34, 197, 94, 0.02));
    }

    .block-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      font-size: 13px;
      font-weight: 700;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .removed .block-header {
      color: #fecaca;
    }

    .added .block-header {
      color: #bbf7d0;
    }

    pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      font-size: 13px;
      line-height: 1.55;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .toolbar {
      display: grid;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
      position: sticky;
      top: 10px;
      z-index: 10;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
      backdrop-filter: blur(10px);
    }

    .toolbar-header {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .toolbar-copy {
      color: var(--muted);
      font-size: 13px;
    }

    .toolbar-progress {
      color: #dbeafe;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .actions-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .actions-row + .actions-row {
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    button {
      appearance: none;
      border: none;
      border-radius: 12px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      background: var(--button);
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
    }

    button:hover {
      background: var(--button-hover);
      transform: translateY(-1px);
    }

    button.primary {
      background: #1f5134;
    }

    button.primary:hover {
      background: #286947;
    }

    button.nav {
      min-width: 44px;
      padding-left: 12px;
      padding-right: 12px;
      font-size: 16px;
      line-height: 1;
    }

    button.danger {
      background: var(--button-danger);
    }

    button.danger:hover {
      background: var(--button-danger-hover);
    }

    button[disabled] {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }
  </style>
</head>
  <body>
  <div class="shell">
    <section class="global-actions">
      <div class="global-actions-title">All Files Actions</div>
      <div class="global-actions-row">
        <button class="primary" ${fileActionDisabled} onclick="send('accept-all-files')">Accept All Files</button>
        <button class="danger" ${fileActionDisabled} onclick="send('reject-all-files')">Reject All Files</button>
      </div>
    </section>

    <section class="header">
      <div class="meta">
        <span class="badge">${escapeHtml(badge)}</span>
        <span class="status">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="title">${headlineHtml}</div>
      <div class="path">${escapeHtml(label)}</div>
    </section>

    <section class="toolbar">
      <div class="toolbar-header">
        <div>
          <div class="toolbar-progress">${escapeHtml(progressLabel)}</div>
          <div class="toolbar-copy">Use this panel to review the current block, handle this file, or finish all remaining files.</div>
        </div>
      </div>
      <div class="actions-row">
        <button class="primary" ${fileActionDisabled} onclick="send('accept-file')">Accept File</button>
        <button class="danger" ${fileActionDisabled} onclick="send('reject-file')">Reject File</button>
      </div>
      <div class="actions-row">
        <button class="nav" ${previousDisabled} onclick="send('previous')">&larr;</button>
        <button class="primary" ${primaryActionDisabled} onclick="send('accept')">Accept</button>
        <button class="danger" ${primaryActionDisabled} onclick="send('reject')">Reject</button>
        <button class="nav" ${nextDisabled} onclick="send('next')">&rarr;</button>
      </div>
    </section>

    ${noticeHtml}

    <section class="stack">
      <article class="block removed">
        <div class="block-header">
          <span>${escapeHtml(baselineTitle)}</span>
          <span>${escapeHtml(`${Math.max(block.originalLines.length, 1)} line${block.originalLines.length === 1 ? '' : 's'}`)}</span>
        </div>
        <pre>${escapeHtml(baselineText)}</pre>
      </article>

      <article class="block added">
        <div class="block-header">
          <span>${escapeHtml(currentTitle)}</span>
          <span>${escapeHtml(`${Math.max(block.modifiedLines.length, 1)} line${block.modifiedLines.length === 1 ? '' : 's'}`)}</span>
        </div>
        <pre>${escapeHtml(currentText)}</pre>
      </article>
    </section>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(type) {
      vscode.postMessage({ type });
    }
  </script>
</body>
</html>`
}

function createReviewPanelUnavailableHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #10141b;
      color: #edf2f7;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      max-width: 680px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 18px;
      background: rgba(255, 255, 255, 0.03);
    }
    .muted {
      color: #99a2b3;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>This review block is no longer available</h2>
      <p class="muted">It was likely accepted, rejected, or replaced by a newer diff. Open another block from the editor or Code Block Review view.</p>
  </div>
</body>
</html>`
}

function createReviewPanelLoadingHtml(previewData) {
  const label = previewData?.label ?? 'Preparing review panel...'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #10141b;
      color: #edf2f7;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      max-width: 680px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 18px;
      background: rgba(255, 255, 255, 0.03);
    }
    .muted {
      color: #99a2b3;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>Loading review panel...</h2>
    <p class="muted">${escapeHtml(label)}</p>
  </div>
</body>
</html>`
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

module.exports = {
  cloneBlockForPreview,
  createBlockTooltip,
  createDecorationOption,
  createReviewPanelHtml,
  createReviewPanelLoadingHtml,
  createReviewPanelUnavailableHtml,
  getBottomActionCodeLensRange,
  getRangeForBlock
}
