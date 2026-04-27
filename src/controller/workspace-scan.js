const vscode = require('vscode')

const DOCUMENT_CHANGE_RESCAN_DEBOUNCE_MS = 1000
const AUTO_CAPTURE_UNBASELINED_FILE_RECENCY_MS = 2 * 60 * 1000

const {
  buildReviewBlocks,
  filterTrackableUris,
  getCurrentTrackedText,
  isTrackableDocument,
  readTrackedTextFromUri,
  safeOpenDocument,
  toWorkspaceLabel
} = require('../review-model')
const {
  buildWorkspaceScanCandidates,
  shouldRunFullWorkspaceScan
} = require('../utils/workspace')

const workspaceScanControllerMethods = {
  // Tracks text edits into the current session, or starts auto capture when an armed baseline sees a qualifying edit.
  async handleDocumentChange(event) {
    if (!isTrackableDocument(event.document)) {
      return
    }

    if (!this.session) {
      const started = await this.maybeStartAutoCaptureFromDocumentChange(event)
      if (!started || !this.session) {
        return
      }
    }

    if (!this.session) {
      return
    }

    const uriString = event.document.uri.toString()
    await this.ensureBaseline(event.document)
    this.session.touchedUris.add(uriString)
    this.markWorkspaceUriDirty(uriString)

    if (this.state === 'reviewing') {
      this.scheduleWorkspaceRescan('document-change', DOCUMENT_CHANGE_RESCAN_DEBOUNCE_MS)
      this.updateStatusBar()
      return
    }

    if (this.sessionMode === 'auto') {
      this.noteAutoCaptureActivity()
    }

    this.updateStatusBar()
  },

  // Records deleted files as dirty session inputs so deletion blocks can be reviewed.
  async handleWorkspaceFilesDeleted(event) {
    if (!this.session) {
      return
    }

    const deletedTrackableUris = filterTrackableUris(event.files)
    if (deletedTrackableUris.length === 0) {
      return
    }

    this.invalidateWorkspaceFileListCache()
    for (const uri of deletedTrackableUris) {
      this.markWorkspaceUriDirty(uri)
    }
    this.noteAutoCaptureActivity()
    await this.scanWorkspaceForChanges('delete-event')
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshAllVisibleEditors()

    if (this.state === 'reviewing') {
      await this.refreshReviewPanel()
      await this.maybeAutoComplete()
    }
  },

  // Ensures newly seen documents diff as session-created files instead of disappearing from review.
  async ensureBaseline(document) {
    if (!this.session) {
      return
    }

    const key = document.uri.toString()
    if (this.hasSessionBaseline(key)) {
      return
    }

    // If a trackable document was not present in the session baseline snapshot,
    // treat it as created during the session so additions diff against empty content.
    this.setSessionBaselineMissing(key)
  },

  async rebuildAllTouchedFiles() {
    if (!this.session) {
      return
    }

    for (const uriString of this.session.touchedUris) {
      await this.rebuildFile(uriString)
    }
  },

  // Rebuilds a single review file while preserving existing block decisions when IDs still match.
  async rebuildFile(uriString, providedDocument) {
    if (!this.session) {
      return
    }

    const previousFile = this.session.reviewFiles.get(uriString)
    const previousStatusById = new Map()

    if (previousFile) {
      for (const block of previousFile.blocks) {
        previousStatusById.set(block.id, block.status)
      }
    }

    const baselineText = await this.getSessionBaselineText(uriString)
    const document = providedDocument ?? (await safeOpenDocument(uriString))
    const currentText = document ? document.getText() : ''
    const targetUri = document ? document.uri : vscode.Uri.parse(uriString)
    this.updateReviewFile(uriString, targetUri, baselineText, currentText, previousStatusById)
  },

  // Converts a baseline/current text pair into pending review blocks for the tree and decorations.
  updateReviewFile(uriString, uri, baselineText, currentText, previousStatusById = new Map()) {
    if (!this.session) {
      return
    }

    const blocks = buildReviewBlocks(baselineText, currentText).map((block) => ({
      ...block,
      status: previousStatusById.get(block.id) ?? 'pending'
    }))

    if (blocks.length === 0) {
      this.session.reviewFiles.delete(uriString)
      this.markReviewDataChanged()
      return
    }

    this.session.reviewFiles.set(uriString, {
      uri,
      label: toWorkspaceLabel(uri),
      blocks
    })
    this.markReviewDataChanged()
  },

  // Captures workspace files that were not already covered by the session's starting baseline.
  async captureWorkspaceBaseline() {
    if (!this.session) {
      return
    }

    const profile = this.profiler.startMark('captureWorkspaceBaseline')
    const workspaceFiles = await this.listTrackableWorkspaceFiles()

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Code Block Review: Capturing workspace baseline',
        cancellable: false
      }, async (progress) => {
        const total = workspaceFiles.length || 1
        let processed = 0

        for (const uri of workspaceFiles) {
          const key = uri.toString()
          if (!this.session || this.hasSessionBaseline(key)) {
            processed += 1
            continue
          }

          if (this.sessionMode === 'auto') {
            // Scoped auto baselines may not include every file in large workspaces.
            // Only treat missing-baseline files as new when they were touched by
            // this capture or look freshly changed; otherwise leave them out so
            // old files from newly discovered roots do not become pending review.
            if (await this.shouldTreatAutoMissingBaselineAsNewFile(uri)) {
              this.setSessionBaselineMissing(key)
            }
          } else {
            const text = await readTrackedTextFromUri(uri)
            if (text !== null) {
              await this.setSessionBaselineText(key, text)
            }
          }

          processed += 1
          if (processed % 50 === 0 || processed === total) {
            progress.report({ increment: (processed / total) * 100 })
          }
        }
      })
    } finally {
      this.profiler.finishMark(profile, {
        workspaceFiles: workspaceFiles.length,
        baselineEntries: this.session?.baselineEntriesByUri.size ?? 0
      })
    }

  },

  // Guards scoped auto-capture sessions from treating unrelated pre-existing files as new work.
  async shouldTreatAutoMissingBaselineAsNewFile(uri) {
    if (!this.session || this.sessionMode !== 'auto' || !uri) {
      return false
    }

    const uriString = uri.toString()
    if (
      this.session.touchedUris.has(uriString) ||
      this.session.reviewFiles.has(uriString) ||
      this.dirtyWorkspaceUris.has(uriString)
    ) {
      return true
    }

    if (vscode.workspace.textDocuments.some((document) => (
      document.uri.toString() === uriString &&
      isTrackableDocument(document) &&
      document.isDirty
    ))) {
      return true
    }

    if (uri.scheme !== 'file') {
      return false
    }

    const startedAtMs = this.session.startedAtMs ?? Date.parse(this.session.startedAt) ?? Date.now()
    const recentCutoff = startedAtMs - AUTO_CAPTURE_UNBASELINED_FILE_RECENCY_MS
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      return stat.mtime >= recentCutoff
    } catch {
      return false
    }
  },

  // Serializes workspace scans and coalesces overlapping full scans.
  async scanWorkspaceForChanges(reason = 'scan') {
    if (!this.session) {
      return
    }

    const requestedFullScan = shouldRunFullWorkspaceScan(reason)
    if (this.workspaceScanPromise) {
      const activeReason = this.workspaceScanReason
      const activeFullScan = shouldRunFullWorkspaceScan(activeReason)
      if (activeFullScan && requestedFullScan) {
        this.profiler.logSnapshot('scanWorkspaceForChanges:coalesced', {
          reason,
          activeReason
        })
        await this.workspaceScanPromise
        return
      }

      await this.workspaceScanPromise
      if (!this.session) {
        return
      }
    }

    const scanPromise = this.performWorkspaceScanForChanges(reason)
    this.workspaceScanPromise = scanPromise
    this.workspaceScanReason = reason
    try {
      await scanPromise
    } finally {
      if (this.workspaceScanPromise === scanPromise) {
        this.workspaceScanPromise = null
        this.workspaceScanReason = null
      }
    }
  },

  // Reconciles tracked files with their baselines and updates the session's review files.
  async performWorkspaceScanForChanges(reason = 'scan') {
    if (!this.session) {
      return
    }

    const profile = this.profiler.startMark('scanWorkspaceForChanges', { reason })
    if (await this.handleSessionGitStateChange(reason)) {
      this.profiler.finishMark(profile, {
        gitStateChanged: 'true'
      })
      return
    }

    const scanSession = this.session
    const dirtyUrisAtScanStart = new Set(this.dirtyWorkspaceUris)
    const workspaceFiles = await this.listTrackableWorkspaceFiles()
    const currentWorkspaceUris = new Map(workspaceFiles.map((uri) => [uri.toString(), uri]))
    const shouldRunFullScan = shouldRunFullWorkspaceScan(reason)
    const candidateUris = buildWorkspaceScanCandidates({
      currentWorkspaceUris,
      shouldRunFullScan,
      baselineUriStrings: this.session?.baselineEntriesByUri.keys() ?? [],
      dirtyWorkspaceUris: this.dirtyWorkspaceUris
    })

    try {
      if (this.session !== scanSession) {
        return
      }

      scanSession.touchedUris.clear()

      for (const [uriString, uri] of candidateUris) {
        if (this.session !== scanSession) {
          return
        }

        const previousFile = scanSession.reviewFiles.get(uriString)
        const previousStatusById = new Map()

        if (previousFile) {
          for (const block of previousFile.blocks) {
            previousStatusById.set(block.id, block.status)
          }
        }

        const existsInWorkspace = uri.scheme !== 'file' || currentWorkspaceUris.has(uriString)
        const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
        const hadBaseline = this.hasSessionBaseline(uriString)

        if (this.session !== scanSession) {
          return
        }

        if (!hadBaseline && currentText === null) {
          if (scanSession.reviewFiles.delete(uriString)) {
            this.markReviewDataChanged()
          }
          continue
        }

        if (!hadBaseline) {
          if (
            this.sessionMode === 'auto' &&
            !(await this.shouldTreatAutoMissingBaselineAsNewFile(uri))
          ) {
            if (scanSession.reviewFiles.delete(uriString)) {
              this.markReviewDataChanged()
            }
            continue
          }

          this.setSessionBaselineMissing(uriString)
        }

        const baselineText = await this.getSessionBaselineText(uriString)
        const comparableCurrentText = currentText ?? ''

        if (baselineText === comparableCurrentText) {
          if (scanSession.reviewFiles.delete(uriString)) {
            this.markReviewDataChanged()
          }
          continue
        }

        scanSession.touchedUris.add(uriString)
        this.updateReviewFile(uriString, uri, baselineText, comparableCurrentText, previousStatusById)
      }
    } finally {
      if (shouldRunFullScan) {
        for (const uriString of dirtyUrisAtScanStart) {
          this.dirtyWorkspaceUris.delete(uriString)
        }
      } else {
        for (const uriString of candidateUris.keys()) {
          this.dirtyWorkspaceUris.delete(uriString)
        }
      }

      this.profiler.finishMark(profile, {
        fullScan: shouldRunFullScan ? 'true' : 'false',
        candidateUris: candidateUris.size,
        touchedUris: this.session?.touchedUris.size ?? 0,
        reviewFiles: this.session?.reviewFiles.size ?? 0,
        dirtyUrisRemaining: this.dirtyWorkspaceUris.size
      })
    }

  }
}

module.exports = {
  workspaceScanControllerMethods
}
