const vscode = require('vscode')
const path = require('path')

const {
  hashText,
  isTrackableDocument,
  isTrackableUri
} = require('../review-model')

const WORKSPACE_INCLUDE_GLOB = '**/*'
const WORKSPACE_EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,out,.next,.turbo,.cache,coverage}/**'

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

function isGitMetadataUri(uri) {
  if (!uri || uri.scheme !== 'file') {
    return false
  }

  const normalizedPath = uri.fsPath.replace(/\\/g, '/')
  return normalizedPath.endsWith('/.git') || normalizedPath.includes('/.git/')
}

function shouldRunFullWorkspaceScan(reason) {
  return !reason ||
    reason === 'manual-refresh' ||
    reason === 'final-pass-1' ||
    reason === 'final-pass-2' ||
    reason === 'delete-event'
}

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
  shouldRunFullWorkspaceScan
}
