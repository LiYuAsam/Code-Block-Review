const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const { hashText } = require('../review-model')

async function createSessionBaselineSnapshotDirectory() {
  const prefix = path.join(os.tmpdir(), 'codex-review-baseline-')
  return fs.mkdtemp(prefix)
}

async function createAutoCaptureBaselineSnapshotDirectory(workspaceKey) {
  const rootDirectory = path.join(os.tmpdir(), 'codex-review-auto-baselines', workspaceKey)
  await fs.mkdir(rootDirectory, { recursive: true })
  return fs.mkdtemp(path.join(rootDirectory, 'armed-'))
}

async function cleanupSnapshotDirectory(snapshotDirectory) {
  if (!snapshotDirectory) {
    return
  }

  try {
    await fs.rm(snapshotDirectory, { recursive: true, force: true })
  } catch {}
}

async function persistBaselineText(snapshotDirectory, uriString, text) {
  if (!snapshotDirectory) {
    return null
  }

  const snapshotPath = path.join(snapshotDirectory, `${hashText(uriString)}-${crypto.randomUUID()}.txt`)
  await fs.writeFile(snapshotPath, text, 'utf8')
  return snapshotPath
}

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
  cloneBaselineEntries,
  createAutoCaptureBaselineSnapshotDirectory,
  createSessionBaselineSnapshotDirectory,
  persistBaselineText,
  readBaselineEntryText
}
