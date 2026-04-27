const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const { hashText } = require('../review-model')

// Manual sessions get a one-off temp directory that is removed when review completes.
async function createSessionBaselineSnapshotDirectory() {
  const prefix = path.join(os.tmpdir(), 'codex-review-baseline-')
  return fs.mkdtemp(prefix)
}

// Armed auto-capture baselines are grouped by workspace so unrelated workspaces do not collide.
async function createAutoCaptureBaselineSnapshotDirectory(workspaceKey) {
  const rootDirectory = path.join(os.tmpdir(), 'codex-review-auto-baselines', workspaceKey)
  await fs.mkdir(rootDirectory, { recursive: true })
  return fs.mkdtemp(path.join(rootDirectory, 'armed-'))
}

// Best-effort cleanup; temp-file deletion should never block user review flow.
async function cleanupSnapshotDirectory(snapshotDirectory) {
  if (!snapshotDirectory) {
    return
  }

  try {
    await fs.rm(snapshotDirectory, { recursive: true, force: true })
  } catch {}
}

// Removes snapshot files that were replaced during an incremental baseline refresh.
async function cleanupSnapshotFiles(snapshotPaths) {
  if (!snapshotPaths) {
    return
  }

  await Promise.all([...snapshotPaths].map(async (snapshotPath) => {
    if (!snapshotPath) {
      return
    }

    try {
      await fs.rm(snapshotPath, { force: true })
    } catch {}
  }))
}

// Stores baseline text out-of-memory and returns the snapshot path used by baseline entries.
async function persistBaselineText(snapshotDirectory, uriString, text) {
  if (!snapshotDirectory) {
    return null
  }

  const snapshotPath = path.join(snapshotDirectory, `${hashText(uriString)}-${crypto.randomUUID()}.txt`)
  await fs.writeFile(snapshotPath, text, 'utf8')
  return snapshotPath
}

// Normalizes empty/missing/snapshot entries into comparable text for diff building.
async function readBaselineEntryText(entry) {
  if (!entry || entry.kind === 'empty' || entry.kind === 'missing') {
    return ''
  }

  if (entry.kind === 'snapshot') {
    try {
      return await fs.readFile(entry.snapshotPath, 'utf8')
    } catch {
      return ''
    }
  }

  return ''
}

function cloneBaselineEntries(entriesByUri) {
  const baselineEntries = new Map()

  for (const [uriString, entry] of entriesByUri.entries()) {
    baselineEntries.set(uriString, { ...entry })
  }

  return baselineEntries
}

module.exports = {
  cleanupSnapshotDirectory,
  cleanupSnapshotFiles,
  cloneBaselineEntries,
  createAutoCaptureBaselineSnapshotDirectory,
  createSessionBaselineSnapshotDirectory,
  persistBaselineText,
  readBaselineEntryText
}
