const vscode = require('vscode')

const MAX_TRACKED_FILE_BYTES = 1024 * 1024
const MAX_DIFF_MATRIX_CELLS = 250000
const MAX_ANCHORED_DIFF_DEPTH = 64
const MAX_ANCHOR_LINE_FREQUENCY = 8
const DEFAULT_IGNORED_REVIEW_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage'
])
const AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS = 'windowFocus'
const AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE = 'activeEditorChange'
const SUPPORTED_AUTO_CAPTURE_TRIGGERS = new Set([
  AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS,
  AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE
])

let cachedIgnoredReviewGlobKey = null
let cachedIgnoredReviewGlobPatterns = []

function isTrackableDocument(document) {
  return isTrackableUri(document?.uri)
}

function isTrackableUri(uri) {
  if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
    return false
  }

  return !shouldIgnoreReviewUri(uri)
}

function filterTrackableUris(uris) {
  if (!Array.isArray(uris)) {
    return []
  }

  return uris.filter((uri) => isTrackableUri(uri))
}

function shouldIgnoreReviewUri(uri) {
  if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
    return true
  }

  const relativePath = normalizeGlobPath(vscode.workspace.asRelativePath(uri, false))
  if (hasIgnoredReviewDirectory(relativePath)) {
    return true
  }

  const patterns = getCompiledIgnoredReviewGlobs()
  if (patterns.length === 0) {
    return false
  }

  const baseName = relativePath.split('/').pop() ?? relativePath

  return patterns.some((pattern) => {
    if (!pattern?.raw) {
      return false
    }

    if (globMatches(baseName, pattern)) {
      return true
    }

    return globMatches(relativePath, pattern)
  })
}

function hasIgnoredReviewDirectory(relativePath) {
  return normalizeGlobPath(relativePath)
    .split('/')
    .some((part) => DEFAULT_IGNORED_REVIEW_DIRECTORIES.has(part))
}

function getIgnoredReviewGlobs() {
  const config = vscode.workspace.getConfiguration('codexReview')
  const configured = config.get('ignoredFileGlobs', [
    '**/pnpm-lock.yaml',
    '**/package-lock.json',
    '**/yarn.lock'
  ])
  if (!Array.isArray(configured)) {
    return []
  }

  return configured
    .map((value) => typeof value === 'string' ? normalizeGlobPath(value.trim()) : '')
    .filter(Boolean)
}

function clearIgnoredReviewGlobsCache() {
  cachedIgnoredReviewGlobKey = null
  cachedIgnoredReviewGlobPatterns = []
}

function normalizeGlobPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function globMatches(value, pattern) {
  const normalizedValue = normalizeGlobPath(value)
  if (!normalizedValue || !pattern?.regexes?.length) {
    return false
  }

  return pattern.regexes.some((regex) => regex.test(normalizedValue))
}

function getCompiledIgnoredReviewGlobs() {
  const patterns = getIgnoredReviewGlobs()
  const key = JSON.stringify(patterns)

  if (cachedIgnoredReviewGlobKey === key) {
    return cachedIgnoredReviewGlobPatterns
  }

  cachedIgnoredReviewGlobKey = key
  cachedIgnoredReviewGlobPatterns = patterns.map((pattern) => ({
    raw: pattern,
    regexes: compileGlobPattern(pattern)
  }))
  return cachedIgnoredReviewGlobPatterns
}

function compileGlobPattern(pattern) {
  const normalizedPattern = normalizeGlobPath(pattern)
  if (!normalizedPattern) {
    return []
  }

  const patternsToTry = normalizedPattern.startsWith('**/')
    ? [normalizedPattern, normalizedPattern.slice(3)]
    : [normalizedPattern]

  return patternsToTry
    .filter(Boolean)
    .map((candidate) => {
      const source = candidate
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replace(/\*\*/g, '::DOUBLE_STAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLE_STAR::/g, '.*')

      return new RegExp(`^${source}$`)
    })
}

function getAutoCaptureSettings() {
  const config = vscode.workspace.getConfiguration('codexReview.autoCapture')
  const configuredTriggerEvents = config.get('triggerEvents', [
    AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS,
    AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE
  ])
  const triggerEvents = new Set(
    (Array.isArray(configuredTriggerEvents) ? configuredTriggerEvents : [])
      .filter((value) => SUPPORTED_AUTO_CAPTURE_TRIGGERS.has(value))
  )

  return {
    enabled: Boolean(config.get('enabled', true)),
    triggerEvents,
    baselineRefreshCooldownMs: clampNumber(config.get('baselineRefreshCooldownSeconds', 10), 0, 3600) * 1000,
    captureIdleMs: clampNumber(config.get('captureIdleSeconds', 4), 1, 600) * 1000,
    reviewOfferMs: clampNumber(config.get('reviewOfferSeconds', 60), 1, 600) * 1000,
    observationWindowMs: clampNumber(config.get('observationWindowSeconds', 1.2), 0.1, 60) * 1000,
    burstEventWindowMs: clampNumber(config.get('burstEventWindowMilliseconds', 500), 50, 10000),
    thresholds: {
      largeChangeLines: clampNumber(config.get('largeChangeLines', 8), 1, 10000),
      largeChangeChars: clampNumber(config.get('largeChangeChars', 200), 1, 1000000),
      multiFileMinFiles: clampNumber(config.get('multiFileMinFiles', 2), 1, 1000),
      multiFileMinLines: clampNumber(config.get('multiFileMinLines', 8), 1, 100000),
      burstMinEvents: clampNumber(config.get('burstMinEvents', 10), 1, 10000),
      burstMinLines: clampNumber(config.get('burstMinLines', 18), 1, 100000)
    }
  }
}

function clampNumber(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return min
  }

  return Math.min(Math.max(value, min), max)
}

function summarizeAutoCaptureEvent(event) {
  let changedLines = 0
  let changedChars = 0
  const touchedLineSpans = []

  for (const change of event.contentChanges) {
    const touchedLineSpan = getTouchedLineSpan(change)
    const touchedLines = touchedLineSpan
      ? (touchedLineSpan[1] - touchedLineSpan[0]) + 1
      : 0

    changedLines += touchedLines
    changedChars += change.text.length + change.rangeLength
    if (touchedLineSpan) {
      touchedLineSpans.push(touchedLineSpan)
    }
  }

  return {
    changedLines,
    changedChars,
    touchedLineSpans
  }
}

function getTouchedLineSpan(change) {
  if (!change || (change.text.length === 0 && change.rangeLength === 0)) {
    return null
  }

  const insertedLines = countInsertedLines(change.text)
  const removedLines = countRemovedLines(change)
  const touchedLines = Math.max(insertedLines, removedLines, 1)
  const startLine = change.range.start.line
  return [startLine, startLine + touchedLines - 1]
}

function countUniqueTouchedLinesAcrossFiles(spansByUri) {
  let total = 0
  for (const spans of spansByUri.values()) {
    total += countUniqueTouchedLines(spans)
  }
  return total
}

function countUniqueTouchedLines(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return 0
  }

  const sorted = spans
    .filter((span) => Array.isArray(span) && span.length === 2)
    .map((span) => [Number(span[0]), Number(span[1])])
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end >= start)
    .sort((a, b) => a[0] - b[0])

  if (sorted.length === 0) {
    return 0
  }

  let total = 0
  let [currentStart, currentEnd] = sorted[0]

  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index]
    if (start <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, end)
      continue
    }

    total += (currentEnd - currentStart) + 1
    currentStart = start
    currentEnd = end
  }

  total += (currentEnd - currentStart) + 1
  return total
}

function isUndoOrRedoChange(event) {
  return event?.reason === vscode.TextDocumentChangeReason.Undo ||
    event?.reason === vscode.TextDocumentChangeReason.Redo
}

function countInsertedLines(text) {
  if (!text) {
    return 0
  }

  return text.split(/\r?\n/).length
}

function countRemovedLines(change) {
  if (!change || change.rangeLength === 0) {
    return 0
  }

  if (change.range.start.line === change.range.end.line) {
    return 1
  }

  return (change.range.end.line - change.range.start.line) + 1
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function summarizeTextDelta(originalText, modifiedText) {
  const blocks = buildReviewBlocks(originalText, modifiedText)
  let changedLines = 0
  let changedChars = 0
  const touchedLineSpans = []

  for (const block of blocks) {
    const originalLineCount = Math.max(block.originalEnd - block.originalStart, 0)
    const modifiedLineCount = Math.max(block.modifiedEnd - block.modifiedStart, 0)
    const touchedLines = Math.max(originalLineCount, modifiedLineCount, 1)
    changedLines += touchedLines
    changedChars += block.originalText.length + block.modifiedText.length
    touchedLineSpans.push([
      block.modifiedStart,
      Math.max(block.modifiedEnd - 1, block.modifiedStart + touchedLines - 1)
    ])
  }

  return {
    changedLines,
    changedChars,
    touchedLineSpans
  }
}

function toWorkspaceLabel(uri) {
  return vscode.workspace.asRelativePath(uri, false)
}

async function safeOpenDocument(uriString) {
  try {
    return await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString))
  } catch {
    return null
  }
}

async function getCurrentTrackedText(uri, existsInWorkspace) {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (openDocument && isTrackableDocument(openDocument)) {
    return openDocument.getText()
  }

  if (uri.scheme === 'untitled') {
    return ''
  }

  if (!existsInWorkspace) {
    return null
  }

  return readTrackedTextFromUri(uri)
}

async function readTrackedTextFromUri(uri) {
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if (stat.size > MAX_TRACKED_FILE_BYTES) {
      return null
    }

    const bytes = await vscode.workspace.fs.readFile(uri)
    if (containsBinaryContent(bytes)) {
      return null
    }

    return Buffer.from(bytes).toString('utf8')
  } catch {
    return null
  }
}

async function uriExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

function containsBinaryContent(bytes) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      return true
    }
  }
  return false
}

function buildReviewBlocks(originalText, modifiedText) {
  const originalLines = splitLines(originalText)
  const modifiedLines = splitLines(modifiedText)
  const ops = diffLines(originalLines, modifiedLines)
  return groupDiffOpsIntoBlocks(ops)
}

function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function splitTextForEdit(text) {
  if (!text) {
    return []
  }

  return text.replace(/\r\n/g, '\n').split('\n')
}

function diffLines(originalLines, modifiedLines) {
  let prefixLength = 0
  const maxPrefix = Math.min(originalLines.length, modifiedLines.length)
  while (prefixLength < maxPrefix && originalLines[prefixLength] === modifiedLines[prefixLength]) {
    prefixLength += 1
  }

  let suffixLength = 0
  const remainingOriginal = originalLines.length - prefixLength
  const remainingModified = modifiedLines.length - prefixLength
  const maxSuffix = Math.min(remainingOriginal, remainingModified)
  while (
    suffixLength < maxSuffix &&
    originalLines[originalLines.length - 1 - suffixLength] === modifiedLines[modifiedLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const prefixOps = originalLines
    .slice(0, prefixLength)
    .map((line) => ({ type: 'equal', line }))
  const suffixOps = suffixLength > 0
    ? originalLines.slice(originalLines.length - suffixLength).map((line) => ({ type: 'equal', line }))
    : []
  const middleOriginal = originalLines.slice(prefixLength, originalLines.length - suffixLength)
  const middleModified = modifiedLines.slice(prefixLength, modifiedLines.length - suffixLength)

  if (middleOriginal.length === 0 && middleModified.length === 0) {
    return [...prefixOps, ...suffixOps]
  }

  const middleCellCount = (middleOriginal.length + 1) * (middleModified.length + 1)
  const middleOps = middleCellCount > MAX_DIFF_MATRIX_CELLS
    ? diffLinesAnchored(middleOriginal, middleModified)
    : diffLinesDynamic(middleOriginal, middleModified)

  return [...prefixOps, ...middleOps, ...suffixOps]
}

function diffLinesDynamic(originalLines, modifiedLines) {
  const rows = originalLines.length
  const cols = modifiedLines.length
  const matrix = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0))

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      if (originalLines[row] === modifiedLines[col]) {
        matrix[row][col] = matrix[row + 1][col + 1] + 1
      } else {
        matrix[row][col] = Math.max(matrix[row + 1][col], matrix[row][col + 1])
      }
    }
  }

  const ops = []
  let row = 0
  let col = 0

  while (row < rows && col < cols) {
    if (originalLines[row] === modifiedLines[col]) {
      ops.push({ type: 'equal', line: originalLines[row] })
      row += 1
      col += 1
      continue
    }

    if (matrix[row + 1][col] >= matrix[row][col + 1]) {
      ops.push({ type: 'delete', line: originalLines[row] })
      row += 1
      continue
    }

    ops.push({ type: 'insert', line: modifiedLines[col] })
    col += 1
  }

  while (row < rows) {
    ops.push({ type: 'delete', line: originalLines[row] })
    row += 1
  }

  while (col < cols) {
    ops.push({ type: 'insert', line: modifiedLines[col] })
    col += 1
  }

  return ops
}

function diffLinesFallback(originalLines, modifiedLines) {
  const ops = []

  for (const line of originalLines) {
    ops.push({ type: 'delete', line })
  }

  for (const line of modifiedLines) {
    ops.push({ type: 'insert', line })
  }

  return ops
}

function diffLinesAnchored(originalLines, modifiedLines, depth = 0) {
  if (originalLines.length === 0 || modifiedLines.length === 0) {
    return diffLinesFallback(originalLines, modifiedLines)
  }

  let prefixLength = 0
  const maxPrefix = Math.min(originalLines.length, modifiedLines.length)
  while (prefixLength < maxPrefix && originalLines[prefixLength] === modifiedLines[prefixLength]) {
    prefixLength += 1
  }

  let suffixLength = 0
  const remainingOriginal = originalLines.length - prefixLength
  const remainingModified = modifiedLines.length - prefixLength
  const maxSuffix = Math.min(remainingOriginal, remainingModified)
  while (
    suffixLength < maxSuffix &&
    originalLines[originalLines.length - 1 - suffixLength] === modifiedLines[modifiedLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const prefixOps = originalLines
    .slice(0, prefixLength)
    .map((line) => ({ type: 'equal', line }))
  const suffixOps = suffixLength > 0
    ? originalLines.slice(originalLines.length - suffixLength).map((line) => ({ type: 'equal', line }))
    : []
  const middleOriginal = originalLines.slice(prefixLength, originalLines.length - suffixLength)
  const middleModified = modifiedLines.slice(prefixLength, modifiedLines.length - suffixLength)

  if (middleOriginal.length === 0 && middleModified.length === 0) {
    return [...prefixOps, ...suffixOps]
  }

  const middleCellCount = (middleOriginal.length + 1) * (middleModified.length + 1)
  if (middleCellCount <= MAX_DIFF_MATRIX_CELLS) {
    return [
      ...prefixOps,
      ...diffLinesDynamic(middleOriginal, middleModified),
      ...suffixOps
    ]
  }

  if (depth >= MAX_ANCHORED_DIFF_DEPTH) {
    return [
      ...prefixOps,
      ...diffLinesFallback(middleOriginal, middleModified),
      ...suffixOps
    ]
  }

  const anchors = findStableLineAnchors(middleOriginal, middleModified)
  if (anchors.length === 0) {
    return [
      ...prefixOps,
      ...diffLinesFallback(middleOriginal, middleModified),
      ...suffixOps
    ]
  }

  const ops = [...prefixOps]
  let previousOriginal = 0
  let previousModified = 0

  for (const anchor of anchors) {
    ops.push(...diffLinesAnchored(
      middleOriginal.slice(previousOriginal, anchor.originalIndex),
      middleModified.slice(previousModified, anchor.modifiedIndex),
      depth + 1
    ))
    ops.push({ type: 'equal', line: middleOriginal[anchor.originalIndex] })
    previousOriginal = anchor.originalIndex + 1
    previousModified = anchor.modifiedIndex + 1
  }

  ops.push(...diffLinesAnchored(
    middleOriginal.slice(previousOriginal),
    middleModified.slice(previousModified),
    depth + 1
  ))
  ops.push(...suffixOps)

  return ops
}

function findStableLineAnchors(originalLines, modifiedLines) {
  const originalPositionsByLine = buildLinePositions(originalLines)
  const modifiedPositionsByLine = buildLinePositions(modifiedLines)
  const candidates = []

  for (const [line, originalPositions] of originalPositionsByLine) {
    const modifiedPositions = modifiedPositionsByLine.get(line)
    if (
      !modifiedPositions ||
      originalPositions.length !== modifiedPositions.length ||
      originalPositions.length > MAX_ANCHOR_LINE_FREQUENCY
    ) {
      continue
    }

    for (let index = 0; index < originalPositions.length; index += 1) {
      candidates.push({
        originalIndex: originalPositions[index],
        modifiedIndex: modifiedPositions[index]
      })
    }
  }

  candidates.sort((left, right) => {
    if (left.originalIndex !== right.originalIndex) {
      return left.originalIndex - right.originalIndex
    }

    return left.modifiedIndex - right.modifiedIndex
  })

  return longestIncreasingAnchorSequence(candidates)
}

function buildLinePositions(lines) {
  const positionsByLine = new Map()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const positions = positionsByLine.get(line)
    if (positions) {
      positions.push(index)
    } else {
      positionsByLine.set(line, [index])
    }
  }

  return positionsByLine
}

function longestIncreasingAnchorSequence(candidates) {
  if (candidates.length === 0) {
    return []
  }

  const tailModifiedIndexes = []
  const tailCandidateIndexes = []
  const previousCandidateIndexes = new Array(candidates.length).fill(-1)

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const position = lowerBound(tailModifiedIndexes, candidate.modifiedIndex)

    if (position > 0) {
      previousCandidateIndexes[index] = tailCandidateIndexes[position - 1]
    }

    tailModifiedIndexes[position] = candidate.modifiedIndex
    tailCandidateIndexes[position] = index
  }

  const sequence = []
  let candidateIndex = tailCandidateIndexes[tailCandidateIndexes.length - 1]

  while (candidateIndex !== -1 && candidateIndex !== undefined) {
    sequence.push(candidates[candidateIndex])
    candidateIndex = previousCandidateIndexes[candidateIndex]
  }

  sequence.reverse()
  return sequence
}

function lowerBound(values, target) {
  let low = 0
  let high = values.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

function groupDiffOpsIntoBlocks(ops) {
  const blocks = []
  let originalLine = 0
  let modifiedLine = 0
  let current = null

  const flush = () => {
    if (!current) {
      return
    }

    current.originalEnd = originalLine
    current.modifiedEnd = modifiedLine
    current.originalText = current.originalLines.join('\n')
    current.modifiedText = current.modifiedLines.join('\n')
    current.changeKind = getBlockChangeKind(current)
    current.id = createBlockId(current)
    blocks.push(current)
    current = null
  }

  for (const op of ops) {
    if (op.type === 'equal') {
      flush()
      originalLine += 1
      modifiedLine += 1
      continue
    }

    if (!current) {
      current = {
        originalStart: originalLine,
        originalEnd: originalLine,
        modifiedStart: modifiedLine,
        modifiedEnd: modifiedLine,
        originalLines: [],
        modifiedLines: [],
        originalText: '',
        modifiedText: '',
        status: 'pending'
      }
    }

    if (op.type === 'delete') {
      current.originalLines.push(op.line)
      originalLine += 1
      continue
    }

    current.modifiedLines.push(op.line)
    modifiedLine += 1
  }

  flush()
  return blocks
}

function createBlockId(block) {
  return [
    block.originalStart,
    block.originalEnd,
    block.modifiedStart,
    block.modifiedEnd,
    hashText(block.originalText),
    hashText(block.modifiedText)
  ].join(':')
}

function hashText(text) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

function rejectBlockFromDocumentText(currentText, block) {
  const currentLines = splitTextForEdit(currentText)
  const replacementLines = splitTextForEdit(block.originalText)
  const start = clamp(block.modifiedStart, 0, currentLines.length)
  const end = clamp(block.modifiedEnd, start, currentLines.length)
  const nextLines = [
    ...currentLines.slice(0, start),
    ...replacementLines,
    ...currentLines.slice(end)
  ]
  return nextLines.join('\n')
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function getBlockChangeKind(block) {
  const hasOriginal = block.originalLines.length > 0
  const hasModified = block.modifiedLines.length > 0

  if (!hasOriginal && hasModified) {
    return 'addition'
  }

  if (hasOriginal && !hasModified) {
    return 'deletion'
  }

  return 'modification'
}

function fullDocumentRange(document) {
  if (document.lineCount === 0) {
    return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
  }

  const lastLine = document.lineAt(document.lineCount - 1)
  return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end)
}

function formatBlockLabel(block) {
  if (block.changeKind === 'addition') {
    const start = block.modifiedStart + 1
    const end = block.modifiedEnd
    return start === end ? `Added line ${start}` : `Added lines ${start}-${end}`
  }

  if (block.changeKind === 'deletion') {
    const line = block.modifiedStart + 1
    return `Deleted near line ${line}`
  }

  if (block.changeKind === 'modification') {
    const oldCount = Math.max(block.originalLines.length, 1)
    const newCount = Math.max(block.modifiedLines.length, 1)
    return `Replaced ${oldCount} old line${oldCount === 1 ? '' : 's'} with ${newCount} new line${newCount === 1 ? '' : 's'}`
  }

  if (block.modifiedEnd > block.modifiedStart) {
    const start = block.modifiedStart + 1
    const end = block.modifiedEnd
    return start === end ? `Line ${start}` : `Lines ${start}-${end}`
  }

  const line = block.modifiedStart + 1
  return `Insertion near line ${line}`
}

function createReviewItem(uri, block) {
  return {
    kind: 'block',
    uri,
    blockId: block.id,
    changeKind: block.changeKind,
    modifiedStart: block.modifiedStart,
    originalStart: block.originalStart,
    originalHash: hashText(block.originalText),
    modifiedHash: hashText(block.modifiedText)
  }
}

function getReviewItemKey(item) {
  if (!item || item.kind !== 'block' || !item.uri || !item.blockId) {
    return null
  }

  return `${item.uri.toString()}::${item.blockId}`
}

function getReviewBlockKey(uri, block) {
  if (!uri || !block?.id) {
    return null
  }

  return `${uri.toString()}::${block.id}`
}

function syncReviewItem(target, source) {
  target.kind = source.kind
  target.uri = source.uri
  target.blockId = source.blockId
  target.changeKind = source.changeKind
  target.modifiedStart = source.modifiedStart
  target.originalStart = source.originalStart
  target.originalHash = source.originalHash
  target.modifiedHash = source.modifiedHash
}

function findBestMatchingBlock(blocks, item) {
  let bestBlock = null
  let bestScore = -1

  for (const candidate of blocks) {
    const score = scoreBlockMatch(candidate, item)
    if (score > bestScore) {
      bestScore = score
      bestBlock = candidate
    }
  }

  return bestScore >= 30 ? bestBlock : null
}

function scoreBlockMatch(candidate, item) {
  let score = 0

  if (item.changeKind && candidate.changeKind === item.changeKind) {
    score += 40
  }

  const candidateOriginalHash = hashText(candidate.originalText)
  const candidateModifiedHash = hashText(candidate.modifiedText)

  if (item.originalHash && candidateOriginalHash === item.originalHash) {
    score += 60
  }

  if (item.modifiedHash && candidateModifiedHash === item.modifiedHash) {
    score += 40
  }

  if (typeof item.modifiedStart === 'number') {
    score += Math.max(0, 25 - Math.abs(candidate.modifiedStart - item.modifiedStart))
  }

  if (typeof item.originalStart === 'number') {
    score += Math.max(0, 15 - Math.abs(candidate.originalStart - item.originalStart))
  }

  return score
}

module.exports = {
  buildReviewBlocks,
  clearIgnoredReviewGlobsCache,
  countUniqueTouchedLinesAcrossFiles,
  createReviewItem,
  filterTrackableUris,
  findBestMatchingBlock,
  formatBlockLabel,
  fullDocumentRange,
  getAutoCaptureSettings,
  getCurrentTrackedText,
  getReviewBlockKey,
  getReviewItemKey,
  hashText,
  isTrackableDocument,
  isTrackableUri,
  isUndoOrRedoChange,
  readTrackedTextFromUri,
  rejectBlockFromDocumentText,
  safeOpenDocument,
  sleep,
  summarizeAutoCaptureEvent,
  summarizeTextDelta,
  syncReviewItem,
  toWorkspaceLabel,
  uriExists
}
