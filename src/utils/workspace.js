const vscode = require('vscode')
const path = require('path')

const {
  hashText,
  isTrackableDocument,
  isTrackableUri
} = require('../review-model')

const WORKSPACE_INCLUDE_GLOB = '**/*'
const WORKSPACE_EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,out,.next,.turbo,.cache,coverage}/**'

// Hashes the current workspace-folder set into a filesystem-safe baseline bucket key.
function getWorkspaceBaselineKey() {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    return 'no-workspace'
  }

  const serializedFolders = folders
    .map((folder) => folder.uri.toString())
    .sort()
    .join('||')

  return hashText(serializedFolders)
}

function getWorkspaceKeyForUri(uri) {
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : null
  return folder?.uri.toString() ?? null
}

function getActiveWorkspaceFolder() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return null
  }

  return vscode.workspace.getWorkspaceFolder(editor.document.uri)
}

// Walks upward from a file until it finds a configured project marker inside the workspace.
async function findNearestProjectRoot(uri, markers) {
  if (!uri || uri.scheme !== 'file') {
    return null
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
    return null
  }

  const markerNames = Array.isArray(markers)
    ? markers.filter((marker) => typeof marker === 'string' && marker.trim().length > 0)
    : []
  if (markerNames.length === 0) {
    return workspaceFolder.uri
  }

  let currentDirectory = path.dirname(uri.fsPath)
  const workspaceRoot = workspaceFolder.uri.fsPath

  while (isPathInsideOrEqual(currentDirectory, workspaceRoot)) {
    if (await directoryHasAnyMarker(currentDirectory, markerNames)) {
      return vscode.Uri.file(currentDirectory)
    }

    if (currentDirectory === workspaceRoot) {
      break
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }
    currentDirectory = parentDirectory
  }

  return workspaceFolder.uri
}

async function directoryHasAnyMarker(directory, markers) {
  for (const marker of markers) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(directory, marker)))
      return true
    } catch {}
  }

  return false
}

function isPathInsideOrEqual(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// Detects .git paths so file watcher events can suppress capture around branch/ref changes.
function isGitMetadataUri(uri) {
  if (!uri || uri.scheme !== 'file') {
    return false
  }

  const normalizedPath = uri.fsPath.replace(/\\/g, '/')
  return normalizedPath.endsWith('/.git') || normalizedPath.includes('/.git/')
}

// Reads the HEAD/ref signature for the nearest Git repository containing a URI.
async function readGitRepositoryStateForUri(uri) {
  if (!uri || uri.scheme !== 'file') {
    return null
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  const workspaceRoot = workspaceFolder?.uri?.scheme === 'file'
    ? workspaceFolder.uri.fsPath
    : null
  let currentDirectory = await getUriDirectoryPath(uri)

  while (currentDirectory && (!workspaceRoot || isPathInsideOrEqual(currentDirectory, workspaceRoot))) {
    const gitMarkerPath = path.join(currentDirectory, '.git')
    const state = await readGitRepositoryStateFromMarker(currentDirectory, gitMarkerPath)
    if (state) {
      return state
    }

    if (workspaceRoot && currentDirectory === workspaceRoot) {
      break
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }
    currentDirectory = parentDirectory
  }

  return null
}

async function readGitRepositoryStateForRoot(repoRootUri) {
  if (!repoRootUri || repoRootUri.scheme !== 'file') {
    return null
  }

  return readGitRepositoryStateFromMarker(repoRootUri.fsPath, path.join(repoRootUri.fsPath, '.git'))
}

async function getUriDirectoryPath(uri) {
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return uri.fsPath
    }
  } catch {}

  return path.dirname(uri.fsPath)
}

// Supports both normal .git directories and worktree/submodule gitdir files.
async function readGitRepositoryStateFromMarker(repoRootPath, gitMarkerPath) {
  let gitDirectory = null
  try {
    const markerStat = await vscode.workspace.fs.stat(vscode.Uri.file(gitMarkerPath))
    if ((markerStat.type & vscode.FileType.Directory) !== 0) {
      gitDirectory = gitMarkerPath
    } else if ((markerStat.type & vscode.FileType.File) !== 0) {
      const markerText = await readTextFile(gitMarkerPath)
      const match = markerText.match(/^gitdir:\s*(.+)\s*$/i)
      if (match) {
        gitDirectory = path.resolve(repoRootPath, match[1].trim())
      }
    }
  } catch {
    return null
  }

  if (!gitDirectory) {
    return null
  }

  const head = (await readTextFile(path.join(gitDirectory, 'HEAD'))).trim()
  if (!head) {
    return null
  }

  const refName = head.startsWith('ref:') ? head.slice(4).trim() : ''
  const commonDirectory = await getGitCommonDirectory(gitDirectory)
  const ref = refName ? await readGitRefValue(commonDirectory, refName) : ''
  const signature = hashText(`${head}\n${ref}`)

  return {
    repoRoot: vscode.Uri.file(repoRootPath).toString(),
    head,
    ref,
    signature
  }
}

async function getGitCommonDirectory(gitDirectory) {
  const commonDirText = (await readTextFile(path.join(gitDirectory, 'commondir'))).trim()
  if (!commonDirText) {
    return gitDirectory
  }

  return path.resolve(gitDirectory, commonDirText)
}

async function readGitRefValue(commonDirectory, refName) {
  const looseRef = (await readTextFile(path.join(commonDirectory, refName))).trim()
  if (looseRef) {
    return looseRef
  }

  const packedRefs = await readTextFile(path.join(commonDirectory, 'packed-refs'))
  for (const line of packedRefs.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue
    }

    const [hash, name] = line.trim().split(/\s+/, 2)
    if (name === refName) {
      return hash || ''
    }
  }

  return ''
}

async function readTextFile(filePath) {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return ''
  }
}

// Full scans are reserved for lifecycle points where dirty-only scans may miss deletions or baseline-only files.
function shouldRunFullWorkspaceScan(reason) {
  return !reason ||
    reason === 'manual-refresh' ||
    reason === 'final-pass-1' ||
    reason === 'final-pass-2' ||
    reason === 'delete-event'
}

// Builds the URI set to reconcile for either a full pass or a dirty-only incremental pass.
function buildWorkspaceScanCandidates(options) {
  const {
    currentWorkspaceUris,
    shouldRunFullScan,
    baselineUriStrings = [],
    dirtyWorkspaceUris = []
  } = options

  if (shouldRunFullScan) {
    const candidateUris = new Map(currentWorkspaceUris)

    for (const document of vscode.workspace.textDocuments) {
      if (isTrackableDocument(document)) {
        candidateUris.set(document.uri.toString(), document.uri)
      }
    }

    for (const uriString of baselineUriStrings) {
      const uri = vscode.Uri.parse(uriString)
      if (!isTrackableUri(uri)) {
        continue
      }

      if (!candidateUris.has(uriString)) {
        candidateUris.set(uriString, uri)
      }
    }

    return candidateUris
  }

  const candidateUris = new Map()

  for (const uriString of dirtyWorkspaceUris) {
    const existingUri = currentWorkspaceUris.get(uriString)
    if (existingUri) {
      candidateUris.set(uriString, existingUri)
      continue
    }

    try {
      const parsedUri = vscode.Uri.parse(uriString)
      if (parsedUri.scheme === 'file' || parsedUri.scheme === 'untitled') {
        candidateUris.set(uriString, parsedUri)
      }
    } catch {}
  }

  return candidateUris
}

module.exports = {
  WORKSPACE_EXCLUDE_GLOB,
  WORKSPACE_INCLUDE_GLOB,
  buildWorkspaceScanCandidates,
  findNearestProjectRoot,
  getActiveWorkspaceFolder,
  getWorkspaceBaselineKey,
  getWorkspaceKeyForUri,
  isGitMetadataUri,
  readGitRepositoryStateForRoot,
  readGitRepositoryStateForUri,
  shouldRunFullWorkspaceScan
}
