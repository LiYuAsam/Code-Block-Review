const vscode = require('vscode')
const path = require('path')
const AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS = 'windowFocus'
const AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE = 'activeEditorChange'
const GIT_ACTIVITY_SUPPRESSION_WINDOW_MS = 4000
const DELETED_FILE_PREVIEW_SCHEME = 'codex-review-deleted'
const WORKSPACE_RESCAN_DEBOUNCE_MS = 200
const DOCUMENT_CHANGE_RESCAN_DEBOUNCE_MS = 1000
const AUTO_CAPTURE_UNBASELINED_FILE_RECENCY_MS = 2 * 60 * 1000
const {
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
} = require('./review-model')
const {
  cloneBlockForPreview,
  createDecorationOption,
  createDeletedBaselineDecorationOption,
  createReviewPanelHtml,
  createReviewPanelLoadingHtml,
  createReviewPanelUnavailableHtml,
  getRangeForBlock
} = require('./review-ui')
const {
  ReviewBlockCodeLensProvider,
  ReviewTreeProvider
} = require('./review-tree')
const {
  cleanupSnapshotDirectory,
  cloneBaselineEntries,
  createAutoCaptureBaselineSnapshotDirectory,
  createSessionBaselineSnapshotDirectory,
  persistBaselineText,
  readBaselineEntryText
} = require('./utils/baseline-snapshots')
const { createReviewDecorations } = require('./utils/decorations')
const { ReviewProfiler } = require('./utils/profiler')
const {
  WORKSPACE_EXCLUDE_GLOB,
  WORKSPACE_INCLUDE_GLOB,
  buildWorkspaceScanCandidates,
  findNearestProjectRoot,
  getActiveWorkspaceFolder,
  getWorkspaceBaselineKey,
  getWorkspaceKeyForUri,
  isGitMetadataUri,
  shouldRunFullWorkspaceScan
} = require('./utils/workspace')

function activate(context) {
  const controller = new ReviewController(context)
  context.subscriptions.push(controller)
}

function deactivate() {}

class ReviewController {
  constructor(context) {
    this.context = context
    this.state = 'idle'
    this.session = null
    this.sessionMode = null
    this.reviewPanelState = null
    this.autoCaptureState = 'idle'
    this.autoCaptureStopTimer = null
    this.autoCaptureReviewOfferTimer = null
    this.autoCaptureObservationTimer = null
    this.autoCaptureBaselineRefreshPromise = null
    this.workspaceRescanTimer = null
    this.pendingWorkspaceRescanReason = null
    this.workspaceScanPromise = null
    this.workspaceScanReason = null
    this.autoCaptureFilesystemProbeTimer = null
    this.visibleEditorsRefreshTimer = null
    this.workspaceWatcherDisposables = []
    this.workspaceFileListCache = null
    this.workspaceFileListPromise = null
    this.reviewDataVersion = 0
    this.cachedFilesVersion = -1
    this.cachedFiles = []
    this.cachedPendingItemsVersion = -1
    this.cachedPendingItems = []
    this.cachedPendingCountVersion = -1
    this.cachedPendingCount = 0
    this.profiler = new ReviewProfiler()
    this.lastAutoCaptureBaselineRefreshAt = 0
    this.autoCaptureBaselineStatus = 'idle'
    this.autoCaptureBaselineStatusMessage = ''
    this.dirtyWorkspaceUris = new Set()
    this.recentGitActivityByWorkspaceKey = new Map()
    this.autoCaptureBaselineWorkspaceKey = getWorkspaceBaselineKey()
    this.autoCaptureBaselineEntriesByUri = new Map()
    this.autoCaptureBaselineSnapshotDirectory = null
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureFilesystemProbeUris = new Set()
    this.recentSaveEventsByUri = new Map()
    this.autoCaptureReviewPending = false
    this.autoCaptureReviewPromptNonce = 0
    this.autoCaptureSettings = getAutoCaptureSettings()
    this.deletedFilePreviewProvider = {
      provideTextDocumentContent: (uri) => this.provideDeletedFilePreviewContent(uri)
    }
    this.initializeWorkspaceWatchers()

    this.treeProvider = new ReviewTreeProvider(this)
    this.blockActionProvider = new ReviewBlockCodeLensProvider(this)
    const decorations = createReviewDecorations()
    this.pendingAddedDecoration = decorations.pendingAdded
    this.pendingDeletedBaselineDecoration = decorations.pendingDeletedBaseline
    this.deletedFilePreviewDecoration = decorations.deletedFilePreview
    this.pendingModifiedDecoration = decorations.pendingModified
    this.currentReviewDecoration = decorations.currentReview
    this.acceptedDecoration = decorations.accepted
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)

    context.subscriptions.push(
      this.pendingAddedDecoration,
      this.pendingDeletedBaselineDecoration,
      this.deletedFilePreviewDecoration,
      this.pendingModifiedDecoration,
      this.currentReviewDecoration,
      this.acceptedDecoration,
      this.statusBarItem,
      this.profiler,
      vscode.workspace.registerTextDocumentContentProvider(DELETED_FILE_PREVIEW_SCHEME, this.deletedFilePreviewProvider),
      vscode.window.registerTreeDataProvider('codexReview.filesView', this.treeProvider),
      vscode.languages.registerCodeLensProvider(
        [
          { scheme: 'file' },
          { scheme: 'untitled' },
          { scheme: DELETED_FILE_PREVIEW_SCHEME }
        ],
        this.blockActionProvider
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.handleDocumentChange(event)
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        this.noteDocumentSaveEvent(event.document)
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.noteDocumentSaveEvent(document)
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        void this.handleWorkspaceFilesDeleted(event)
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        void this.handleConfigurationChange(event)
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.initializeWorkspaceWatchers()
      }),
      vscode.window.onDidChangeWindowState((windowState) => {
        void this.handleWindowStateChange(windowState)
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshAllVisibleEditors()
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.refreshAllVisibleEditors()
        void this.handleActiveTextEditorChange(editor)
      }),
      vscode.commands.registerCommand('codexReview.startSession', () => this.startSession()),
      vscode.commands.registerCommand('codexReview.stopSession', () => this.stopSession()),
      vscode.commands.registerCommand('codexReview.enterReadyReview', () => this.enterReadyReview()),
      vscode.commands.registerCommand('codexReview.completeReview', () => this.completeReview()),
      vscode.commands.registerCommand('codexReview.refreshReview', () => this.refreshReview()),
      vscode.commands.registerCommand('codexReview.openReviewPanel', (item) => this.openReviewPanel(item)),
      vscode.commands.registerCommand('codexReview.openBlock', (item) => this.openBlock(item)),
      vscode.commands.registerCommand('codexReview.previewBlock', (item) => this.previewBlock(item)),
      vscode.commands.registerCommand('codexReview.acceptBlock', (item) => this.acceptBlock(item)),
      vscode.commands.registerCommand('codexReview.rejectBlock', (item) => this.rejectBlock(item)),
      vscode.commands.registerCommand('codexReview.acceptBlockAndAdvance', (item) => this.acceptBlockAndAdvance(item)),
      vscode.commands.registerCommand('codexReview.rejectBlockAndAdvance', (item) => this.rejectBlockAndAdvance(item)),
      vscode.commands.registerCommand('codexReview.openPreviousPendingBlock', (item) => this.openAdjacentPendingBlock(item, -1)),
      vscode.commands.registerCommand('codexReview.openNextPendingBlock', (item) => this.openAdjacentPendingBlock(item, 1)),
      vscode.commands.registerCommand('codexReview.acceptFile', (item) => this.acceptFile(item)),
      vscode.commands.registerCommand('codexReview.rejectFile', (item) => this.rejectFile(item)),
      vscode.commands.registerCommand('codexReview.showProfilerOutput', () => {
        this.profiler.show(true)
      })
    )

    this.syncContexts()
    this.profiler.logSnapshot('activate')
    void this.ensureAutoCaptureReady({ refreshBaseline: true, silent: true })
    this.updateStatusBar()
  }

  dispose() {
    this.clearAutoCaptureTimers()
    this.clearWorkspaceRescanTimer()
    this.clearAutoCaptureFilesystemProbeTimer()
    this.clearVisibleEditorsRefreshTimer()
    void this.cleanupAutoCaptureBaselineSnapshots()
    void this.cleanupSessionBaselineSnapshots()
    this.disposeWorkspaceWatchers()
    this.disposeReviewPanel()
    this.clearDecorations()
  }

  initializeWorkspaceWatchers() {
    this.disposeWorkspaceWatchers()
    this.invalidateWorkspaceFileListCache()
    this.autoCaptureBaselineWorkspaceKey = getWorkspaceBaselineKey()

    const folders = vscode.workspace.workspaceFolders ?? []
    for (const folder of folders) {
      // Use a RelativePattern rooted at each workspace folder so file watching
      // is explicitly constrained to the current project/workspace only.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, WORKSPACE_INCLUDE_GLOB)
      )

      this.workspaceWatcherDisposables.push(
        watcher,
        watcher.onDidChange((uri) => {
          void this.handleWorkspaceFileChanged('change', uri)
        }),
        watcher.onDidCreate((uri) => {
          void this.handleWorkspaceFileChanged('create', uri)
        }),
        watcher.onDidDelete((uri) => {
          void this.handleWorkspaceFileChanged('delete', uri)
        })
      )
    }
  }

  disposeWorkspaceWatchers() {
    for (const disposable of this.workspaceWatcherDisposables) {
      disposable.dispose()
    }
    this.workspaceWatcherDisposables = []
  }

  async handleConfigurationChange(event) {
    if (!event.affectsConfiguration('codexReview')) {
      return
    }

    this.autoCaptureSettings = getAutoCaptureSettings()
    this.profiler.refreshConfiguration()
    this.invalidateWorkspaceFileListCache()
    clearIgnoredReviewGlobsCache()

    if (!this.autoCaptureSettings.enabled) {
      this.resetAutoCaptureArmedState()
      if (this.sessionMode !== 'auto') {
        this.updateStatusBar()
      }
      await this.syncContexts()
      return
    }

    if (this.state === 'reviewing' && this.session) {
      await this.refreshReview()
      await this.refreshReviewPanel()
    }

    if (this.sessionMode === 'auto' && this.state === 'capturing') {
      if (this.autoCaptureReviewPending) {
        this.scheduleAutoReviewOfferTimer()
      } else {
        this.bumpAutoCaptureStopTimer()
      }
    }

    await this.ensureAutoCaptureReady({ refreshBaseline: true, silent: true })

    this.treeProvider.refresh()
    this.updateStatusBar()
    await this.syncContexts()
  }

  async handleWindowStateChange(windowState) {
    if (!windowState.focused) {
      return
    }

    await this.armAutoCapture(AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS, { refreshBaseline: true })
  }

  async handleActiveTextEditorChange(editor) {
    if (!editor || !isTrackableDocument(editor.document)) {
      return
    }

    await this.armAutoCapture(AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE, { refreshBaseline: true })
  }

  clearAutoStopTimer() {
    if (this.autoCaptureStopTimer) {
      clearTimeout(this.autoCaptureStopTimer)
      this.autoCaptureStopTimer = null
    }
  }

  clearAutoReviewOfferTimer() {
    if (this.autoCaptureReviewOfferTimer) {
      clearTimeout(this.autoCaptureReviewOfferTimer)
      this.autoCaptureReviewOfferTimer = null
    }
  }

  clearAutoObservationTimer() {
    if (this.autoCaptureObservationTimer) {
      clearTimeout(this.autoCaptureObservationTimer)
      this.autoCaptureObservationTimer = null
    }
  }

  clearAutoCaptureTimers() {
    this.clearAutoStopTimer()
    this.clearAutoReviewOfferTimer()
    this.clearAutoObservationTimer()
  }

  clearWorkspaceRescanTimer() {
    if (this.workspaceRescanTimer) {
      clearTimeout(this.workspaceRescanTimer)
      this.workspaceRescanTimer = null
    }
    this.pendingWorkspaceRescanReason = null
  }

  clearAutoCaptureFilesystemProbeTimer() {
    if (this.autoCaptureFilesystemProbeTimer) {
      clearTimeout(this.autoCaptureFilesystemProbeTimer)
      this.autoCaptureFilesystemProbeTimer = null
    }
  }

  clearVisibleEditorsRefreshTimer() {
    if (this.visibleEditorsRefreshTimer) {
      clearTimeout(this.visibleEditorsRefreshTimer)
      this.visibleEditorsRefreshTimer = null
    }
  }

  invalidateWorkspaceFileListCache() {
    this.workspaceFileListCache = null
    this.workspaceFileListPromise = null
  }

  markReviewDataChanged() {
    this.reviewDataVersion += 1
  }

  markWorkspaceUriDirty(uriOrString) {
    if (!uriOrString) {
      return
    }

    const uriString = typeof uriOrString === 'string' ? uriOrString : uriOrString.toString()
    if (!uriString) {
      return
    }

    this.dirtyWorkspaceUris.add(uriString)
    if (this.session) {
      this.session.finalWorkspaceDiffClean = false
    }
  }

  async listTrackableWorkspaceFiles() {
    if (this.workspaceFileListCache) {
      return this.workspaceFileListCache
    }

    if (this.workspaceFileListPromise) {
      return this.workspaceFileListPromise
    }

    this.workspaceFileListPromise = (async () => {
      const files = filterTrackableUris(
        await vscode.workspace.findFiles(WORKSPACE_INCLUDE_GLOB, WORKSPACE_EXCLUDE_GLOB)
      )
      this.workspaceFileListCache = files
      return files
    })().finally(() => {
      this.workspaceFileListPromise = null
    })

    return this.workspaceFileListPromise
  }

  async listAutoCaptureBaselineFiles() {
    if (this.autoCaptureSettings.scope === 'workspace') {
      return this.listTrackableWorkspaceFiles()
    }

    const roots = await this.getAutoCaptureBaselineScopeRoots()
    if (roots.length === 0) {
      return this.listTrackableWorkspaceFiles()
    }

    return this.listTrackableWorkspaceFilesForRoots(roots)
  }

  async getAutoCaptureBaselineScopeRoots() {
    const rootsByKey = new Map()
    const activeRoot = await this.getActiveProjectRoot()
    if (activeRoot) {
      rootsByKey.set(activeRoot.toString(), activeRoot)
    }

    if (this.autoCaptureSettings.scope === 'touchedProjects') {
      for (const entry of this.autoCaptureEvidence) {
        const root = await this.getProjectRootForUriString(entry.uri)
        if (root) {
          rootsByKey.set(root.toString(), root)
        }
      }

      for (const uriString of this.autoCaptureFilesystemProbeUris) {
        const root = await this.getProjectRootForUriString(uriString)
        if (root) {
          rootsByKey.set(root.toString(), root)
        }
      }
    }

    return [...rootsByKey.values()]
  }

  async getActiveProjectRoot() {
    const editor = vscode.window.activeTextEditor
    if (editor?.document?.uri) {
      const projectRoot = await this.getProjectRootForUri(editor.document.uri)
      if (projectRoot) {
        return projectRoot
      }
    }

    const activeWorkspaceFolder = getActiveWorkspaceFolder()
    return activeWorkspaceFolder?.uri ?? null
  }

  async getProjectRootForUriString(uriString) {
    try {
      return this.getProjectRootForUri(vscode.Uri.parse(uriString))
    } catch {
      return null
    }
  }

  async getProjectRootForUri(uri) {
    const nearestRoot = await findNearestProjectRoot(uri, this.autoCaptureSettings.projectRootMarkers)
    if (nearestRoot) {
      return nearestRoot
    }

    return vscode.workspace.getWorkspaceFolder(uri)?.uri ?? null
  }

  async listTrackableWorkspaceFilesForRoots(roots) {
    const filesByKey = new Map()

    for (const root of roots) {
      if (!root || root.scheme !== 'file') {
        continue
      }

      const files = filterTrackableUris(await vscode.workspace.findFiles(
        new vscode.RelativePattern(root.fsPath, WORKSPACE_INCLUDE_GLOB),
        WORKSPACE_EXCLUDE_GLOB
      ))

      for (const uri of files) {
        filesByKey.set(uri.toString(), uri)
      }
    }

    return [...filesByKey.values()]
  }

  markRecentGitActivity(uri) {
    const workspaceKey = getWorkspaceKeyForUri(uri)
    if (!workspaceKey) {
      return
    }

    this.recentGitActivityByWorkspaceKey.set(workspaceKey, Date.now())
  }

  hasRecentGitActivity(summary) {
    if (!summary || this.autoCaptureEvidence.length === 0) {
      return false
    }

    if (!summary.hasLargeChange && summary.uniqueFileCount < 2 && summary.totalChangedLines < 8) {
      return false
    }

    const cutoff = Date.now() - GIT_ACTIVITY_SUPPRESSION_WINDOW_MS
    for (const entry of this.autoCaptureEvidence) {
      try {
        const workspaceKey = getWorkspaceKeyForUri(vscode.Uri.parse(entry.uri))
        if (!workspaceKey) {
          continue
        }

        const lastGitActivityAt = this.recentGitActivityByWorkspaceKey.get(workspaceKey) ?? 0
        if (lastGitActivityAt >= cutoff) {
          return true
        }
      } catch {}
    }

    return false
  }

  noteDocumentSaveEvent(document) {
    if (!document || !isTrackableDocument(document)) {
      return
    }

    this.recentSaveEventsByUri.set(document.uri.toString(), Date.now())
  }

  hasRecentSaveEvent(uriString) {
    const lastSavedAt = this.recentSaveEventsByUri.get(uriString) ?? 0
    if (lastSavedAt <= 0) {
      return false
    }

    const windowMs = this.autoCaptureSettings.observationWindowMs ?? 1200
    if ((Date.now() - lastSavedAt) <= windowMs) {
      return true
    }

    this.recentSaveEventsByUri.delete(uriString)
    return false
  }

  hasSessionBaseline(uriString) {
    return Boolean(this.session?.baselineEntriesByUri.has(uriString))
  }

  async ensureAutoCaptureBaselineSnapshotDirectory() {
    if (this.autoCaptureBaselineSnapshotDirectory) {
      return this.autoCaptureBaselineSnapshotDirectory
    }

    const workspaceKey = this.autoCaptureBaselineWorkspaceKey || getWorkspaceBaselineKey()
    const snapshotDirectory = await createAutoCaptureBaselineSnapshotDirectory(workspaceKey)
    this.autoCaptureBaselineSnapshotDirectory = snapshotDirectory
    return snapshotDirectory
  }

  async cleanupAutoCaptureBaselineSnapshots() {
    const snapshotDirectory = this.autoCaptureBaselineSnapshotDirectory
    if (!snapshotDirectory) {
      return
    }

    this.autoCaptureBaselineSnapshotDirectory = null
    await cleanupSnapshotDirectory(snapshotDirectory)
  }

  async cleanupSessionBaselineSnapshots(session = this.session) {
    const snapshotDirectory = session?.baselineSnapshotDirectory
    if (!snapshotDirectory) {
      return
    }

    session.baselineSnapshotDirectory = null
    await cleanupSnapshotDirectory(snapshotDirectory)
  }

  async persistSessionBaselineText(uriString, text) {
    if (!this.session) {
      return null
    }

    const snapshotDirectory = this.session.baselineSnapshotDirectory
    if (!snapshotDirectory) {
      return null
    }

    const snapshotPath = await persistBaselineText(snapshotDirectory, uriString, text)
    this.session.baselineEntriesByUri.set(uriString, {
      kind: 'snapshot',
      snapshotPath
    })
    return snapshotPath
  }

  async persistAutoCaptureBaselineText(uriString, text) {
    const snapshotDirectory = await this.ensureAutoCaptureBaselineSnapshotDirectory()
    return persistBaselineText(snapshotDirectory, uriString, text)
  }

  async setSessionBaselineText(uriString, text) {
    if (!this.session) {
      return
    }

    if (!text) {
      this.session.baselineEntriesByUri.set(uriString, { kind: 'empty' })
      return
    }

    await this.persistSessionBaselineText(uriString, text)
  }

  setSessionBaselineMissing(uriString) {
    if (!this.session) {
      return
    }

    this.session.baselineEntriesByUri.set(uriString, { kind: 'missing' })
  }

  hasSessionMissingBaseline(uriString) {
    return this.session?.baselineEntriesByUri.get(uriString)?.kind === 'missing'
  }

  async getSessionBaselineText(uriString) {
    if (!this.session) {
      return ''
    }

    const entry = this.session.baselineEntriesByUri.get(uriString)
    return readBaselineEntryText(entry)
  }

  hasAutoCaptureIdleBaseline(uriString) {
    return this.autoCaptureBaselineEntriesByUri.has(uriString)
  }

  async setAutoCaptureIdleBaselineText(uriString, text) {
    if (!text) {
      this.autoCaptureBaselineEntriesByUri.set(uriString, { kind: 'empty' })
      return
    }

    const snapshotPath = await this.persistAutoCaptureBaselineText(uriString, text)
    this.autoCaptureBaselineEntriesByUri.set(uriString, {
      kind: 'snapshot',
      snapshotPath,
      contentHash: hashText(text)
    })
  }

  deleteAutoCaptureIdleBaseline(uriString) {
    this.autoCaptureBaselineEntriesByUri.delete(uriString)
  }

  async getAutoCaptureIdleBaselineText(uriString) {
    const entry = this.autoCaptureBaselineEntriesByUri.get(uriString)
    return readBaselineEntryText(entry)
  }

  async getAutoCaptureCandidateBaselineText(uriString) {
    const candidateBaseline = this.autoCaptureCandidateBaselineByUri.get(uriString)
    if (candidateBaseline?.kind === 'missing') {
      return ''
    }

    if (typeof candidateBaseline === 'string') {
      return candidateBaseline
    }

    return this.getAutoCaptureIdleBaselineText(uriString)
  }

  buildAutoCaptureBaselineEntryMap() {
    return cloneBaselineEntries(this.autoCaptureBaselineEntriesByUri)
  }

  async refreshAutoCaptureBaseline() {
    if (this.autoCaptureBaselineRefreshPromise) {
      return this.autoCaptureBaselineRefreshPromise
    }

    this.autoCaptureBaselineStatus = 'syncing'
    this.autoCaptureBaselineStatusMessage = 'Syncing auto-capture baseline...'
    this.updateStatusBar()

    this.autoCaptureBaselineRefreshPromise = (async () => {
      const profile = this.profiler.startMark('refreshAutoCaptureBaseline')
      const nextEntriesByUri = new Map()
      let reusedCount = 0
      let updatedCount = 0

      try {
        for (const document of vscode.workspace.textDocuments) {
          if (isTrackableDocument(document)) {
            const uriString = document.uri.toString()
            const text = document.getText()
            const contentHash = hashText(text)
            const previousEntry = this.autoCaptureBaselineEntriesByUri.get(uriString)
            if (
              previousEntry?.kind === 'snapshot' &&
              previousEntry.contentHash === contentHash &&
              previousEntry.snapshotPath
            ) {
              nextEntriesByUri.set(uriString, previousEntry)
              reusedCount += 1
              continue
            }

            const snapshotPath = await this.persistAutoCaptureBaselineText(uriString, text)
            nextEntriesByUri.set(uriString, {
              kind: 'snapshot',
              snapshotPath,
              contentHash
            })
            updatedCount += 1
          }
        }

        const workspaceFiles = await this.listAutoCaptureBaselineFiles()
        for (const uri of workspaceFiles) {
          const key = uri.toString()
          if (nextEntriesByUri.has(key)) {
            continue
          }

          const previousEntry = this.autoCaptureBaselineEntriesByUri.get(key)
          const fileStat = await this.getBaselineFileStat(uri)
          if (
            previousEntry?.kind === 'snapshot' &&
            fileStat &&
            previousEntry.mtime === fileStat.mtime &&
            previousEntry.size === fileStat.size &&
            previousEntry.snapshotPath
          ) {
            nextEntriesByUri.set(key, previousEntry)
            reusedCount += 1
            continue
          }

          const text = await readTrackedTextFromUri(uri)
          if (text !== null) {
            const snapshotPath = await this.persistAutoCaptureBaselineText(key, text)
            nextEntriesByUri.set(key, {
              kind: 'snapshot',
              snapshotPath,
              contentHash: hashText(text),
              mtime: fileStat?.mtime,
              size: fileStat?.size
            })
            updatedCount += 1
          }
        }

        this.autoCaptureBaselineEntriesByUri = nextEntriesByUri
        this.lastAutoCaptureBaselineRefreshAt = Date.now()
        this.autoCaptureBaselineStatus = 'ready'
        this.autoCaptureBaselineStatusMessage =
          `Baseline ready with ${nextEntriesByUri.size} files (${reusedCount} reused, ${updatedCount} updated)`
      } catch (error) {
        this.autoCaptureBaselineStatus = 'failed'
        this.autoCaptureBaselineStatusMessage = error?.message
          ? `Baseline sync failed: ${error.message}`
          : 'Baseline sync failed'
        throw error
      } finally {
        this.profiler.finishMark(profile, {
          fileCount: nextEntriesByUri.size,
          baselineEntryCount: this.autoCaptureBaselineEntriesByUri.size,
          candidateCount: this.autoCaptureCandidateBaselineByUri.size,
          snapshotDir: this.autoCaptureBaselineSnapshotDirectory ? 'ready' : 'missing',
          reusedCount,
          updatedCount
        })
      }
    })().finally(() => {
      this.autoCaptureBaselineRefreshPromise = null
      this.updateStatusBar()
    })

    return this.autoCaptureBaselineRefreshPromise
  }

  async getBaselineFileStat(uri) {
    if (!uri || uri.scheme !== 'file') {
      return null
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri)
      return {
        mtime: stat.mtime,
        size: stat.size
      }
    } catch {
      return null
    }
  }

  resetAutoCaptureArmedState() {
    this.clearAutoReviewOfferTimer()
    this.clearAutoObservationTimer()
    this.autoCaptureState = 'idle'
    this.autoCaptureBaselineEntriesByUri = new Map()
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureReviewPending = false
    this.autoCaptureReviewPromptNonce += 1
    this.lastAutoCaptureBaselineRefreshAt = 0
    this.autoCaptureBaselineStatus = 'idle'
    this.autoCaptureBaselineStatusMessage = ''
    void this.cleanupAutoCaptureBaselineSnapshots()
    this.profiler.logSnapshot('resetAutoCaptureArmedState', {
      baselineEntryCount: this.autoCaptureBaselineEntriesByUri.size,
      candidateCount: this.autoCaptureCandidateBaselineByUri.size,
      snapshotDir: this.autoCaptureBaselineSnapshotDirectory ? 'ready' : 'cleared'
    })
    this.treeProvider.refresh()
  }

  async ensureAutoCaptureReady(options = {}) {
    const {
      refreshBaseline = false,
      silent = false
    } = options

    if (!this.autoCaptureSettings.enabled) {
      return
    }

    if (this.state !== 'idle' || this.sessionMode) {
      return
    }

    const shouldRefreshBaseline = this.shouldRefreshAutoCaptureBaseline(refreshBaseline)
    const wasArmed = this.autoCaptureState === 'armed'

    this.autoCaptureState = 'armed'
    if (!wasArmed || shouldRefreshBaseline) {
      this.autoCaptureEvidence = []
      this.autoCaptureCandidateBaselineByUri = new Map()
      this.clearAutoObservationTimer()
    }
    if (shouldRefreshBaseline) {
      await this.refreshAutoCaptureBaseline()
    } else if (this.autoCaptureBaselineRefreshPromise) {
      await this.autoCaptureBaselineRefreshPromise
    }
    this.treeProvider.refresh()

    if (!silent) {
      this.updateStatusBar()
      void this.syncContexts()
    }
  }

  async armAutoCapture(trigger, options = {}) {
    if (!this.autoCaptureSettings.enabled) {
      return
    }

    if (!this.autoCaptureSettings.triggerEvents.has(trigger)) {
      return
    }

    if (this.state !== 'idle' || this.sessionMode) {
      return
    }

    // Once we have started collecting candidate evidence for the current burst,
    // don't let follow-up focus/editor signals refresh the idle baseline and
    // accidentally absorb newly created or modified files into that baseline.
    if (this.autoCaptureState === 'armed' && this.autoCaptureEvidence.length > 0) {
      return
    }

    await this.ensureAutoCaptureReady(options)
    this.updateStatusBar()
    void this.syncContexts()
  }

  shouldRefreshAutoCaptureBaseline(refreshRequested) {
    if (this.autoCaptureBaselineEntriesByUri.size === 0) {
      return true
    }

    if (!refreshRequested) {
      return false
    }

    const cooldownMs = this.autoCaptureSettings.baselineRefreshCooldownMs ?? 0
    if (cooldownMs <= 0) {
      return true
    }

    return (Date.now() - this.lastAutoCaptureBaselineRefreshAt) >= cooldownMs
  }

  bumpAutoCaptureStopTimer() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing') {
      return
    }

    this.clearAutoStopTimer()
    this.autoCaptureStopTimer = setTimeout(() => {
      if (this.sessionMode === 'auto' && this.state === 'capturing') {
        void this.handleAutoCaptureIdleReached()
      }
    }, this.autoCaptureSettings.captureIdleMs)
  }

  noteAutoCaptureActivity() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing') {
      return
    }

    if (this.autoCaptureReviewPending) {
      this.autoCaptureReviewPending = false
      this.clearAutoReviewOfferTimer()
      this.autoCaptureReviewPromptNonce += 1
    }
    this.bumpAutoCaptureStopTimer()
  }

  scheduleAutoReviewOfferTimer() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
      return
    }

    this.clearAutoReviewOfferTimer()
    this.autoCaptureReviewOfferTimer = setTimeout(() => {
      if (this.sessionMode === 'auto' && this.state === 'capturing' && this.autoCaptureReviewPending) {
        void this.completeReview(null, { silent: true })
      }
    }, this.autoCaptureSettings.reviewOfferMs)
  }

  promptAutoReviewOffer() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
      return
    }

    const promptNonce = ++this.autoCaptureReviewPromptNonce
    void vscode.window.showInformationMessage(
      `Code Block Review captured ${this.getPendingBlockCount()} pending block${this.getPendingBlockCount() === 1 ? '' : 's'}.`,
      'Start Review',
      'Skip'
    ).then((selection) => {
      if (promptNonce !== this.autoCaptureReviewPromptNonce) {
        return
      }

      if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
        return
      }

      if (selection === 'Start Review') {
        void this.enterReadyReviewAndOpenFirstPendingBlock()
        return
      }

      if (selection === 'Skip') {
        void this.completeReview(null, { silent: true })
      }
    })
  }

  async recordAutoCaptureEvidence(event) {
    const uriString = event.document.uri.toString()
    this.autoCaptureEvidence.push({
      timestamp: Date.now(),
      uri: uriString,
      ...summarizeAutoCaptureEvent(event)
    })
  }

  getAutoCaptureEvidenceSummary() {
    const thresholds = this.autoCaptureSettings.thresholds
    const uniqueUris = new Set()
    const touchedLineSpansByUri = new Map()
    let totalChangedChars = 0
    let hasLargeChange = false
    let rapidEventCount = 0
    const rapidEventCutoff = Date.now() - this.autoCaptureSettings.burstEventWindowMs

    for (const entry of this.autoCaptureEvidence) {
      uniqueUris.add(entry.uri)
      totalChangedChars += entry.changedChars
      const spans = touchedLineSpansByUri.get(entry.uri) ?? []
      spans.push(...entry.touchedLineSpans)
      touchedLineSpansByUri.set(entry.uri, spans)
      if (entry.timestamp >= rapidEventCutoff) {
        rapidEventCount += 1
      }

      if (
        entry.changedLines >= thresholds.largeChangeLines ||
        entry.changedChars >= thresholds.largeChangeChars
      ) {
        hasLargeChange = true
      }
    }

    return {
      rapidEventCount,
      uniqueFileCount: uniqueUris.size,
      totalChangedLines: countUniqueTouchedLinesAcrossFiles(touchedLineSpansByUri),
      totalChangedChars,
      hasLargeChange
    }
  }

  shouldStartAutoCaptureFromEvidence() {
    const summary = this.getAutoCaptureEvidenceSummary()
    const thresholds = this.autoCaptureSettings.thresholds
    const burstAssistThreshold = Math.max(1, thresholds.burstMinEvents - 4)
    const multiFileAssistThreshold = Math.max(burstAssistThreshold, thresholds.burstMinEvents - 2)
    const adjustedBurstMinLines =
      summary.rapidEventCount >= burstAssistThreshold
        ? Math.max(1, thresholds.burstMinLines - 4)
        : thresholds.burstMinLines
    const adjustedMultiFileMinLines =
      summary.rapidEventCount >= multiFileAssistThreshold &&
      summary.uniqueFileCount >= thresholds.multiFileMinFiles
        ? Math.max(1, thresholds.multiFileMinLines - 2)
        : thresholds.multiFileMinLines

    if (summary.hasLargeChange) {
      if (this.hasRecentGitActivity(summary)) {
        this.profiler.logSnapshot('autoCaptureSkippedGitLike', {
          uniqueFileCount: summary.uniqueFileCount,
          totalChangedLines: summary.totalChangedLines,
          totalChangedChars: summary.totalChangedChars
        })
        return false
      }
      return true
    }

    if (
      summary.uniqueFileCount >= thresholds.multiFileMinFiles &&
      summary.totalChangedLines >= adjustedMultiFileMinLines
    ) {
      if (this.hasRecentGitActivity(summary)) {
        this.profiler.logSnapshot('autoCaptureSkippedGitLike', {
          uniqueFileCount: summary.uniqueFileCount,
          totalChangedLines: summary.totalChangedLines,
          totalChangedChars: summary.totalChangedChars
        })
        return false
      }
      return true
    }

    if (summary.totalChangedLines >= adjustedBurstMinLines) {
      if (this.hasRecentGitActivity(summary)) {
        this.profiler.logSnapshot('autoCaptureSkippedGitLike', {
          uniqueFileCount: summary.uniqueFileCount,
          totalChangedLines: summary.totalChangedLines,
          totalChangedChars: summary.totalChangedChars
        })
        return false
      }
      return true
    }

    return false
  }

  scheduleAutoCaptureObservationTimeout() {
    if (this.autoCaptureObservationTimer) {
      clearTimeout(this.autoCaptureObservationTimer)
    }

    this.autoCaptureObservationTimer = setTimeout(() => {
      this.autoCaptureObservationTimer = null
      void this.handleAutoCaptureObservationTimeout()
    }, this.autoCaptureSettings.observationWindowMs)
  }

  async handleAutoCaptureObservationTimeout() {
    if (this.state !== 'idle' || this.autoCaptureState !== 'armed') {
      return
    }

    if (this.shouldStartAutoCaptureFromEvidence()) {
      await this.startAutoCaptureFromEvidence()
      return
    }

    await this.absorbAutoCaptureEvidenceIntoBaseline()
    this.updateStatusBar()
    await this.syncContexts()
  }

  async absorbAutoCaptureEvidenceIntoBaseline() {
    if (!this.autoCaptureEvidence.length) {
      return
    }

    const touchedUris = new Set(this.autoCaptureEvidence.map((entry) => entry.uri))
    let updatedCount = 0
    let removedCount = 0
    for (const uriString of touchedUris) {
      const uri = vscode.Uri.parse(uriString)
      const existsInWorkspace = uri.scheme !== 'file' || (await uriExists(uri))
      const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
      if (currentText === null) {
        this.deleteAutoCaptureIdleBaseline(uriString)
        removedCount += 1
        continue
      }

      await this.setAutoCaptureIdleBaselineText(uriString, currentText)
      updatedCount += 1
    }

    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureBaselineStatus = 'ready'
    this.autoCaptureBaselineStatusMessage = this.formatIncrementalBaselineStatusMessage(updatedCount, removedCount)
  }

  async absorbCurrentDocumentIntoAutoBaseline(document) {
    if (!document || !isTrackableDocument(document)) {
      return
    }

    const uriString = document.uri.toString()
    await this.setAutoCaptureIdleBaselineText(uriString, document.getText())
    this.autoCaptureCandidateBaselineByUri.delete(uriString)
    this.autoCaptureBaselineStatus = 'ready'
    this.autoCaptureBaselineStatusMessage = this.formatIncrementalBaselineStatusMessage(1, 0)
  }

  formatIncrementalBaselineStatusMessage(updatedCount, removedCount) {
    const parts = []
    if (updatedCount > 0) {
      parts.push(`${updatedCount} updated`)
    }
    if (removedCount > 0) {
      parts.push(`${removedCount} removed`)
    }

    const changeSummary = parts.length > 0 ? ` (${parts.join(', ')})` : ''
    return `Baseline ready with ${this.autoCaptureBaselineEntriesByUri.size} files${changeSummary}`
  }

  dropAutoCaptureEvidenceForUri(uriString) {
    if (!uriString) {
      return
    }

    this.autoCaptureEvidence = this.autoCaptureEvidence.filter((entry) => entry.uri !== uriString)
    this.autoCaptureCandidateBaselineByUri.delete(uriString)
    this.autoCaptureFilesystemProbeUris.delete(uriString)
    if (this.autoCaptureEvidence.length === 0) {
      this.clearAutoObservationTimer()
    }
  }

  async handleWorkspaceFileChanged(kind, uri) {
    if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
      return
    }

    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      return
    }

    if (isGitMetadataUri(uri)) {
      this.markRecentGitActivity(uri)
      return
    }

    if (!isTrackableUri(uri)) {
      return
    }

    if (kind === 'create' || kind === 'delete') {
      this.invalidateWorkspaceFileListCache()
    }

    if (this.session) {
      this.markWorkspaceUriDirty(uri)
      this.noteAutoCaptureActivity()
      this.scheduleWorkspaceRescan(`watcher-${kind}`)
      return
    }

    if (!this.autoCaptureSettings.enabled) {
      return
    }

    this.scheduleAutoCaptureFilesystemProbe(uri)
  }

  scheduleWorkspaceRescan(reason = 'watcher', delayMs = WORKSPACE_RESCAN_DEBOUNCE_MS) {
    this.pendingWorkspaceRescanReason = reason
    if (this.workspaceRescanTimer) {
      return
    }

    this.workspaceRescanTimer = setTimeout(() => {
      this.workspaceRescanTimer = null
      const pendingReason = this.pendingWorkspaceRescanReason ?? 'watcher'
      this.pendingWorkspaceRescanReason = null
      void this.flushScheduledWorkspaceRescan(pendingReason)
    }, delayMs)
  }

  async flushScheduledWorkspaceRescan(reason) {
    if (!this.session) {
      return
    }

    await this.scanWorkspaceForChanges(reason)
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshAllVisibleEditors()

    if (this.state === 'reviewing') {
      await this.refreshReviewPanel()
      await this.maybeAutoComplete()
    }
  }

  scheduleAutoCaptureFilesystemProbe(uri) {
    this.autoCaptureFilesystemProbeUris.add(uri.toString())
    if (this.autoCaptureFilesystemProbeTimer) {
      return
    }

    this.autoCaptureFilesystemProbeTimer = setTimeout(() => {
      this.autoCaptureFilesystemProbeTimer = null
      void this.flushAutoCaptureFilesystemProbe()
    }, 200)
  }

  async flushAutoCaptureFilesystemProbe() {
    if (!this.autoCaptureSettings.enabled || this.session || this.state !== 'idle') {
      this.autoCaptureFilesystemProbeUris.clear()
      return
    }

    await this.ensureAutoCaptureReady({ silent: true })

    if (this.autoCaptureState !== 'armed' || this.state !== 'idle') {
      this.autoCaptureFilesystemProbeUris.clear()
      return
    }

    const pendingUriStrings = [...this.autoCaptureFilesystemProbeUris]
    this.autoCaptureFilesystemProbeUris.clear()

    for (const uriString of pendingUriStrings) {
      const uri = vscode.Uri.parse(uriString)
      if (!isTrackableUri(uri)) {
        continue
      }

      const existsInWorkspace = await uriExists(uri)
      const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
      const baselineText = await this.getAutoCaptureCandidateBaselineText(uriString)

      if (currentText === null && !this.hasAutoCaptureIdleBaseline(uriString)) {
        this.dropAutoCaptureEvidenceForUri(uriString)
        continue
      }

      if (currentText === baselineText) {
        this.dropAutoCaptureEvidenceForUri(uriString)
        continue
      }

      if (!this.autoCaptureCandidateBaselineByUri.has(uriString)) {
        this.autoCaptureCandidateBaselineByUri.set(
          uriString,
          this.hasAutoCaptureIdleBaseline(uriString) ? baselineText : { kind: 'missing' }
        )
      }
      this.autoCaptureEvidence = this.autoCaptureEvidence.filter((entry) => entry.uri !== uriString)
      this.autoCaptureEvidence.push({
        timestamp: Date.now(),
        uri: uriString,
        ...summarizeTextDelta(baselineText, currentText ?? '')
      })
    }

    if (!this.autoCaptureEvidence.length) {
      this.updateStatusBar()
      await this.syncContexts()
      return
    }

    if (this.shouldStartAutoCaptureFromEvidence()) {
      await this.startAutoCaptureFromEvidence()
      return
    }

    this.scheduleAutoCaptureObservationTimeout()
    this.updateStatusBar()
    await this.syncContexts()
  }

  async startAutoCaptureFromEvidence() {
    if (this.state !== 'idle' || this.autoCaptureState !== 'armed') {
      return false
    }

    const baselineEntries = this.buildAutoCaptureBaselineEntryMap()
    const baselineOverrides = new Map(this.autoCaptureCandidateBaselineByUri)
    const adoptedBaselineSnapshotDirectory = this.autoCaptureBaselineSnapshotDirectory
    const observedEvidence = [...this.autoCaptureEvidence]
    const started = await this.startSession({
      mode: 'auto',
      silent: true,
      baselineEntries,
      baselineOverrides,
      adoptedBaselineSnapshotDirectory,
      initialTouchedUris: observedEvidence.map((entry) => entry.uri)
    })

    if (!started || !this.session) {
      return false
    }

    for (const entry of observedEvidence) {
      this.session.touchedUris.add(entry.uri)
    }

    await this.captureAutoSessionTouchedFilesFromBaseline()
    this.bumpAutoCaptureStopTimer()
    this.updateStatusBar()
    return true
  }

  async captureAutoSessionTouchedFilesFromBaseline() {
    if (!this.session || this.sessionMode !== 'auto') {
      return
    }

    const workspaceFiles = await this.listTrackableWorkspaceFiles()
    const currentWorkspaceUris = new Map(workspaceFiles.map((uri) => [uri.toString(), uri]))
    const candidateUris = new Map(currentWorkspaceUris)

    for (const document of vscode.workspace.textDocuments) {
      if (isTrackableDocument(document)) {
        candidateUris.set(document.uri.toString(), document.uri)
      }
    }

    for (const uriString of this.session.baselineEntriesByUri.keys()) {
      const uri = vscode.Uri.parse(uriString)
      if (!isTrackableUri(uri)) {
        continue
      }

      if (!candidateUris.has(uriString)) {
        candidateUris.set(uriString, uri)
      }
    }

    for (const [uriString, uri] of candidateUris) {
      const existsInWorkspace = uri.scheme !== 'file' || currentWorkspaceUris.has(uriString)
      const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
      const hadBaseline = this.hasSessionBaseline(uriString)

      if (!hadBaseline && currentText === null) {
        continue
      }

      if (
        !hadBaseline &&
        this.sessionMode === 'auto' &&
        !(await this.shouldTreatAutoMissingBaselineAsNewFile(uri))
      ) {
        continue
      }

      const baselineText = await this.getSessionBaselineText(uriString)
      const comparableCurrentText = currentText ?? ''

      if (baselineText !== comparableCurrentText) {
        this.session.touchedUris.add(uriString)
      }
    }
  }

  async maybeStartAutoCaptureFromDocumentChange(event) {
    if (!this.autoCaptureSettings.enabled) {
      return false
    }

    if (!this.isAutoCaptureReadyForDocumentChange()) {
      if (!this.autoCaptureBaselineRefreshPromise) {
        void this.ensureAutoCaptureReady({ silent: true })
      }
      return false
    }

    if (this.autoCaptureState !== 'armed' || this.state !== 'idle') {
      return false
    }

    const uriString = event.document.uri.toString()
    if (await this.isDocumentBackAtAutoCaptureBaseline(event.document)) {
      this.dropAutoCaptureEvidenceForUri(uriString)
      this.updateStatusBar()
      await this.syncContexts()
      return false
    }

    if (isUndoOrRedoChange(event)) {
      await this.absorbCurrentDocumentIntoAutoBaseline(event.document)
      this.autoCaptureEvidence = []
      this.clearAutoObservationTimer()
      this.updateStatusBar()
      await this.syncContexts()
      return false
    }

    if (this.shouldIgnoreSaveTriggeredFixEvent(event)) {
      await this.absorbCurrentDocumentIntoAutoBaseline(event.document)
      this.dropAutoCaptureEvidenceForUri(uriString)
      this.updateStatusBar()
      await this.syncContexts()
      return false
    }

    await this.recordAutoCaptureEvidence(event)

    if (this.shouldStartAutoCaptureFromEvidence()) {
      return this.startAutoCaptureFromEvidence()
    }

    this.scheduleAutoCaptureObservationTimeout()
    return false
  }

  shouldIgnoreSaveTriggeredFixEvent(event) {
    const uriString = event.document.uri.toString()
    if (!this.hasRecentSaveEvent(uriString)) {
      return false
    }

    const summary = summarizeAutoCaptureEvent(event)
    if (summary.changedLines === 0) {
      return false
    }

    return event.contentChanges.length > 1 ||
      summary.changedLines >= this.autoCaptureSettings.thresholds.largeChangeLines ||
      summary.changedChars >= this.autoCaptureSettings.thresholds.largeChangeChars
  }

  isAutoCaptureReadyForDocumentChange() {
    return this.autoCaptureState === 'armed' &&
      this.state === 'idle' &&
      this.autoCaptureBaselineEntriesByUri.size > 0 &&
      !this.autoCaptureBaselineRefreshPromise
  }

  async isDocumentBackAtAutoCaptureBaseline(document) {
    const uriString = document.uri.toString()
    if (!this.autoCaptureCandidateBaselineByUri.has(uriString)) {
      return false
    }

    const candidateBaselineText = await this.getAutoCaptureCandidateBaselineText(uriString)
    return document.getText() === candidateBaselineText
  }

  async startSession(options = {}) {
    const profile = this.profiler.startMark('startSession', { mode: options.mode ?? 'manual' })
    const {
      mode = 'manual',
      silent = false,
      baselineEntries = null,
      baselineOverrides = null,
      adoptedBaselineSnapshotDirectory = null,
      initialTouchedUris = []
    } = options

    if (this.state !== 'idle') {
      if (!silent) {
        void vscode.window.showInformationMessage('A review session is already active.')
      }
      return false
    }

    try {
      this.clearAutoStopTimer()
      this.clearAutoReviewOfferTimer()
      if (
        adoptedBaselineSnapshotDirectory &&
        adoptedBaselineSnapshotDirectory === this.autoCaptureBaselineSnapshotDirectory
      ) {
        this.autoCaptureBaselineSnapshotDirectory = null
      }
      this.resetAutoCaptureArmedState()
      this.dirtyWorkspaceUris.clear()
      const baselineSnapshotDirectory = adoptedBaselineSnapshotDirectory ?? await createSessionBaselineSnapshotDirectory()
      this.sessionMode = mode
      const startedAtMs = Date.now()
      this.session = {
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        baselineEntriesByUri: new Map(),
        baselineSnapshotDirectory,
        touchedUris: new Set(),
        reviewFiles: new Map(),
        finalWorkspaceDiffClean: false
      }
      this.markReviewDataChanged()

      if (mode === 'auto' && Array.isArray(initialTouchedUris)) {
        for (const uriString of initialTouchedUris) {
          if (uriString) {
            this.session.touchedUris.add(uriString)
          }
        }
      }

      if (baselineEntries instanceof Map) {
        for (const [key, entry] of baselineEntries.entries()) {
          if (entry?.kind === 'snapshot' && entry.snapshotPath) {
            this.session.baselineEntriesByUri.set(key, { ...entry })
          } else if (entry?.kind === 'empty' || entry?.kind === 'missing') {
            this.session.baselineEntriesByUri.set(key, { kind: entry.kind })
          }
        }
      }

      if (baselineOverrides instanceof Map) {
        for (const [key, baseline] of baselineOverrides.entries()) {
          if (baseline?.kind === 'missing') {
            this.setSessionBaselineMissing(key)
          } else {
            await this.setSessionBaselineText(key, baseline)
          }
        }
      }

      for (const document of vscode.workspace.textDocuments) {
        if (!isTrackableDocument(document)) {
          continue
        }

        const key = document.uri.toString()
        if (mode === 'manual') {
          await this.setSessionBaselineText(key, document.getText())
        } else if (!this.hasSessionBaseline(key)) {
          this.setSessionBaselineMissing(key)
        }
      }

      await this.captureWorkspaceBaseline()

      this.state = 'capturing'
      this.autoCaptureReviewPending = false
      await this.syncContexts()
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()
      if (!silent) {
        void vscode.window.showInformationMessage('Code Block Review capture started.')
      }

      return true
    } finally {
      this.profiler.finishMark(profile, {
        baselineEntries: this.session?.baselineEntriesByUri.size ?? 0,
        touchedUris: this.session?.touchedUris.size ?? 0
      })
    }
  }

  async stopSession(options = {}) {
    const profile = this.profiler.startMark('stopSession', { requestedMode: options.requestedMode ?? '' })
    const {
      silent = false,
      requestedMode = null
    } = options

    if (this.state !== 'capturing') {
      if (!silent) {
        void vscode.window.showInformationMessage('There is no capture session to stop.')
      }
      return false
    }

    if (requestedMode && this.sessionMode !== requestedMode) {
      return false
    }

    try {
      this.clearAutoStopTimer()
      this.clearAutoReviewOfferTimer()
      const canReuseAutoFinalPass = this.sessionMode === 'auto' &&
        this.autoCaptureReviewPending &&
        this.session?.finalWorkspaceDiffClean
      this.autoCaptureReviewPending = false
      this.state = 'reviewing'
      if (!canReuseAutoFinalPass) {
        await this.runFinalWorkspaceDiffPass()
      } else {
        this.profiler.logSnapshot('runFinalWorkspaceDiffPass:reused', {
          reason: 'auto-ready-clean'
        })
      }
      await this.syncContexts()
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()

      const pending = this.getPendingBlockCount()
      if (pending === 0) {
        await this.completeReview('No review blocks were found. Session closed.', { silent })
        return true
      }

      if (!silent) {
        void vscode.window.showInformationMessage(`Code Block Review entered review mode with ${pending} pending block${pending === 1 ? '' : 's'}.`)
      }

      return true
    } finally {
      this.profiler.finishMark(profile, {
        pendingBlocks: this.getPendingBlockCount(),
        reviewFiles: this.session?.reviewFiles.size ?? 0
      })
    }
  }

  async enterReadyReview() {
    if (this.sessionMode === 'auto' && this.state === 'capturing' && this.autoCaptureReviewPending) {
      const entered = await this.stopSession({
        silent: true,
        requestedMode: 'auto'
      })
      if (entered) {
        await this.openReviewPanel()
      }
      return entered
    }

    if (this.state === 'reviewing') {
      await this.openReviewPanel()
      return true
    }

    return false
  }

  async enterReadyReviewAndOpenFirstPendingBlock() {
    const entered = await this.enterReadyReviewWithoutPanel()
    if (!entered) {
      return false
    }

    return this.openFirstPendingBlock()
  }

  async enterReadyReviewWithoutPanel() {
    if (this.sessionMode === 'auto' && this.state === 'capturing' && this.autoCaptureReviewPending) {
      return this.stopSession({
        silent: true,
        requestedMode: 'auto'
      })
    }

    return this.state === 'reviewing'
  }

  async handleAutoCaptureIdleReached() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing') {
      return
    }

    this.clearAutoStopTimer()
    await this.runFinalWorkspaceDiffPass()

    const pending = this.getPendingBlockCount()
    if (pending === 0) {
      await this.completeReview(null, { silent: true })
      return
    }

    this.autoCaptureReviewPending = true
    this.autoCaptureReviewPromptNonce += 1
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    await this.syncContexts()
    this.promptAutoReviewOffer()
    this.scheduleAutoReviewOfferTimer()
  }

  async runFinalWorkspaceDiffPass() {
    const profile = this.profiler.startMark('runFinalWorkspaceDiffPass')
    try {
      await this.scanWorkspaceForChanges('final-pass-1')

      // Give late-arriving file writes and watcher events a brief chance to settle.
      // Only run a second pass if something actually became dirty during that window.
      await sleep(300)
      const pendingDirtyCount = this.dirtyWorkspaceUris.size
      if (pendingDirtyCount > 0) {
        await this.scanWorkspaceForChanges('final-pass-2-dirty')
      }
      if (this.session) {
        this.session.finalWorkspaceDiffClean = this.dirtyWorkspaceUris.size === 0
      }
      this.profiler.finishMark(profile, {
        touchedUris: this.session?.touchedUris.size ?? 0,
        reviewFiles: this.session?.reviewFiles.size ?? 0,
        secondPass: pendingDirtyCount > 0 ? 'dirty-only' : 'skipped',
        dirtyAfterWait: pendingDirtyCount
      })
    } catch (error) {
      this.profiler.finishMark(profile, {
        touchedUris: this.session?.touchedUris.size ?? 0,
        reviewFiles: this.session?.reviewFiles.size ?? 0,
        failed: 'true'
      })
      throw error
    }
  }

  async completeReview(message, options = {}) {
    const profile = this.profiler.startMark('completeReview', { silent: options.silent ? 'true' : 'false' })
    const { silent = false } = options

    if (this.state === 'idle') {
      return
    }

    try {
      this.clearAutoStopTimer()
      this.clearAutoReviewOfferTimer()
      this.state = 'idle'
      const completedSession = this.session
      this.session = null
      this.sessionMode = null
      this.markReviewDataChanged()
      this.resetAutoCaptureArmedState()
      this.disposeReviewPanel()
      await this.cleanupSessionBaselineSnapshots(completedSession)
      await this.syncContexts()
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()

      await this.ensureAutoCaptureReady({ refreshBaseline: true, silent: true })
      this.updateStatusBar()
      await this.syncContexts()

      if (message && !silent) {
        void vscode.window.showInformationMessage(message)
      }
    } finally {
      this.profiler.finishMark(profile, { state: this.state })
    }
  }

  async refreshReview() {
    if (!this.session) {
      return
    }

    const profile = this.profiler.startMark('refreshReview')
    try {
      await this.scanWorkspaceForChanges('manual-refresh')
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()
      await this.maybeAutoComplete()
    } finally {
      this.profiler.finishMark(profile, {
        pendingBlocks: this.getPendingBlockCount(),
        reviewFiles: this.session?.reviewFiles.size ?? 0
      })
    }
  }

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
  }
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
  }

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
  }

  async rebuildAllTouchedFiles() {
    if (!this.session) {
      return
    }

    for (const uriString of this.session.touchedUris) {
      await this.rebuildFile(uriString)
    }
  }

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
  }

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
  }

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

  }

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
  }

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
  }

  async performWorkspaceScanForChanges(reason = 'scan') {
    if (!this.session) {
      return
    }

    const profile = this.profiler.startMark('scanWorkspaceForChanges', { reason })
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

  getFiles() {
    if (!this.session) {
      return []
    }

    if (this.cachedFilesVersion !== this.reviewDataVersion) {
      this.cachedFiles = [...this.session.reviewFiles.values()].sort((left, right) => left.label.localeCompare(right.label))
      this.cachedFilesVersion = this.reviewDataVersion
    }

    return this.cachedFiles
  }

  getPendingBlockCount() {
    if (!this.session) {
      return 0
    }

    if (this.cachedPendingCountVersion !== this.reviewDataVersion) {
      let count = 0
      for (const file of this.session.reviewFiles.values()) {
        for (const block of file.blocks) {
          if (block.status === 'pending') {
            count += 1
          }
        }
      }
      this.cachedPendingCount = count
      this.cachedPendingCountVersion = this.reviewDataVersion
    }

    return this.cachedPendingCount
  }

  async openReviewSourceDocument(blockInfo) {
    if (await this.shouldUseDeletedFilePreview(blockInfo)) {
      return {
        document: await vscode.workspace.openTextDocument(this.createDeletedFilePreviewUri(blockInfo)),
        isDeletedFilePreview: true
      }
    }

    return {
      document: await vscode.workspace.openTextDocument(blockInfo.uri),
      isDeletedFilePreview: false
    }
  }

  async shouldUseDeletedFilePreview(blockInfo) {
    return Boolean(
      blockInfo?.block?.changeKind === 'deletion' &&
      blockInfo.uri?.scheme === 'file' &&
      !(await uriExists(blockInfo.uri))
    )
  }

  createDeletedFilePreviewUri(blockInfo) {
    const params = new URLSearchParams({
      uri: blockInfo.uri.toString(),
      block: blockInfo.block.id
    })
    return vscode.Uri.from({
      scheme: DELETED_FILE_PREVIEW_SCHEME,
      path: blockInfo.uri.path,
      query: params.toString()
    })
  }

  provideDeletedFilePreviewContent(uri) {
    const blockInfo = this.findDeletedFilePreviewBlock(uri)
    if (!blockInfo) {
      return '// Deleted file preview is no longer available.'
    }

    return blockInfo.block.originalText || ''
  }

  findDeletedFilePreviewBlock(uri) {
    if (!this.session) {
      return null
    }

    const params = new URLSearchParams(uri.query)
    const sourceUri = params.get('uri')
    const blockId = params.get('block')
    if (!sourceUri || !blockId) {
      return null
    }

    const file = this.session.reviewFiles.get(sourceUri)
    if (!file) {
      return null
    }

    const block = file.blocks.find((candidate) => candidate.id === blockId)
    if (!block) {
      return null
    }

    return {
      uri: file.uri,
      block
    }
  }

  getSourceRangeForBlock(document, block, isDeletedFilePreview) {
    if (!isDeletedFilePreview) {
      return getRangeForBlock(document, block)
    }

    if (document.lineCount === 0) {
      return null
    }

    const startLine = Math.min(Math.max(block.originalStart, 0), document.lineCount - 1)
    const endLine = Math.min(Math.max(block.originalEnd - 1, startLine), document.lineCount - 1)
    return new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end)
  }

  async openBlock(item, options = {}) {
    const block = this.findBlockItem(item)
    if (!block) {
      return
    }

    const source = await this.openReviewSourceDocument(block)
    const document = source.document
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: options.viewColumn,
      preview: false,
      preserveFocus: options.preserveFocus
    })
    const range = this.getSourceRangeForBlock(document, block.block, source.isDeletedFilePreview)
    if (range) {
      editor.selection = new vscode.Selection(range.start, range.start)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    }
  }

  async openFirstPendingBlock() {
    if (this.state !== 'reviewing' || !this.session) {
      return false
    }

    const firstPendingItem = this.getOrderedPendingBlockItems()[0] ?? null
    if (!firstPendingItem) {
      void vscode.window.showInformationMessage('No pending review blocks are available.')
      return false
    }

    await this.openBlock(firstPendingItem)
    return true
  }

  async openAdjacentPendingBlock(item, direction) {
    if (this.state !== 'reviewing' || !this.session) {
      return false
    }

    const targetItem = this.getAdjacentPendingBlockItem(item, direction)
    if (!targetItem) {
      return false
    }

    await this.openBlock(targetItem)
    return true
  }

  async openReviewPanel(item) {
    if (this.state !== 'reviewing' || !this.session) {
      return
    }

    let targetItem = null

    if (item?.kind === 'block') {
      const block = this.findBlockItem(item)
      if (block) {
        targetItem = createReviewItem(block.uri, block.block)
      }
    } else if (item?.kind === 'file') {
      const file = this.findFileItem(item)
      const block = file?.blocks.find((candidate) => candidate.status === 'pending') ?? file?.blocks[0]
      if (file && block) {
        targetItem = createReviewItem(file.uri, block)
      }
    } else if (this.reviewPanelState?.currentItem) {
      const block = this.findBlockItem(this.reviewPanelState.currentItem)
      if (block) {
        targetItem = createReviewItem(block.uri, block.block)
      }
    }

    if (!targetItem) {
      targetItem = this.getOrderedPendingBlockItems()[0] ?? null
    }

    if (!targetItem) {
      void vscode.window.showInformationMessage('No pending review blocks are available.')
      return
    }

    await this.showReviewPanel(targetItem)
  }

  async saveReviewDocument(uri) {
    if (!uri || uri.scheme !== 'file') {
      return true
    }

    if (!(await uriExists(uri))) {
      return true
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri)
      if (!document.isDirty) {
        return true
      }

      const saved = await document.save()
      if (!saved) {
        void vscode.window.showWarningMessage(`Failed to save ${toWorkspaceLabel(uri)}.`)
      }
      return saved
    } catch {
      void vscode.window.showWarningMessage(`Failed to save ${toWorkspaceLabel(uri)}.`)
      return false
    }
  }

  async applyTextToUri(uri, text) {
    if (!uri) {
      return false
    }

    const document = await safeOpenDocument(uri.toString())
    if (document) {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, fullDocumentRange(document), text)
      const applied = await vscode.workspace.applyEdit(edit)
      if (!applied) {
        return false
      }

      await this.saveReviewDocument(document.uri)
      return true
    }

    if (uri.scheme !== 'file') {
      return false
    }

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'))
      this.invalidateWorkspaceFileListCache()
      return true
    } catch {
      return false
    }
  }

  async deleteFileUri(uri) {
    if (!uri || uri.scheme !== 'file') {
      return false
    }

    try {
      const edit = new vscode.WorkspaceEdit()
      edit.deleteFile(uri, { ignoreIfNotExists: true })
      const applied = await vscode.workspace.applyEdit(edit)
      if (applied) {
        this.invalidateWorkspaceFileListCache()
      }
      return applied
    } catch {
      return false
    }
  }

  async rejectUriToBaseline(uri, baselineText) {
    if (this.hasSessionMissingBaseline(uri.toString())) {
      return this.deleteFileUri(uri)
    }

    return this.applyTextToUri(uri, baselineText)
  }

  async finishRejectedMissingFile(uri) {
    if (!this.session || !uri) {
      return
    }

    const uriString = uri.toString()
    this.session.reviewFiles.delete(uriString)
    this.session.touchedUris.delete(uriString)
    this.dirtyWorkspaceUris.delete(uriString)
    this.markReviewDataChanged()
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(uriString)
    await this.maybeAutoComplete()
  }

  async acceptBlock(item) {
    const block = this.findBlockItem(item)
    if (!block || block.block.status !== 'pending') {
      return
    }

    block.block.status = 'accepted'
    this.markReviewDataChanged()
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(block.uri.toString())
    await this.saveReviewDocument(block.uri)
    await this.refreshReviewPanel()
    await this.maybeAutoComplete()
  }

  async acceptBlockAndAdvance(item) {
    const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(item)
    const sourceViewColumn = this.getVisibleEditorViewColumn(deletedPreviewUri)
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.acceptBlock(item)
    await this.closeDeletedFilePreviewEditors(deletedPreviewUri)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem, { viewColumn: sourceViewColumn })
    }
  }

  async previewBlock(item) {
    await this.openReviewPanel(item)
  }

  async rejectBlock(item) {
    const block = this.findBlockItem(item)
    if (!block) {
      void vscode.window.showWarningMessage('Could not find the selected review block.')
      return
    }

    const document = await safeOpenDocument(block.uri.toString())
    const currentText = document ? document.getText() : ''
    const nextText = rejectBlockFromDocumentText(currentText, block.block)
    const shouldDeleteFile = nextText === '' && this.hasSessionMissingBaseline(block.uri.toString())
    const applied = nextText === ''
      ? await this.rejectUriToBaseline(block.uri, nextText)
      : await this.applyTextToUri(block.uri, nextText)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject block.')
      return
    }

    if (shouldDeleteFile) {
      await this.finishRejectedMissingFile(block.uri)
    } else {
      await this.refreshChangedReviewFile(block.uri)
    }
    await this.refreshReviewPanel()

    if (currentText === nextText) {
      void vscode.window.showInformationMessage('Reject did not change the file. The block may already match the baseline.')
    }
  }

  async rejectBlockAndAdvance(item) {
    const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(item)
    const sourceViewColumn = this.getVisibleEditorViewColumn(deletedPreviewUri)
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.rejectBlock(item)
    await this.closeDeletedFilePreviewEditors(deletedPreviewUri)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem, { viewColumn: sourceViewColumn })
    }
  }

  async getDeletedFilePreviewUriForItem(item) {
    const block = this.findBlockItem(item)
    if (!block || !(await this.shouldUseDeletedFilePreview(block))) {
      return null
    }

    return this.createDeletedFilePreviewUri(block)
  }

  getVisibleEditorViewColumn(uri) {
    if (!uri) {
      return undefined
    }

    const uriString = uri.toString()
    return vscode.window.visibleTextEditors.find((editor) => (
      editor.document.uri.toString() === uriString
    ))?.viewColumn
  }

  async closeDeletedFilePreviewEditors(uri) {
    if (!uri || uri.scheme !== DELETED_FILE_PREVIEW_SCHEME) {
      return
    }

    const uriString = uri.toString()
    const tabGroups = vscode.window.tabGroups
    if (tabGroups?.all && typeof tabGroups.close === 'function') {
      const tabsToClose = []
      for (const group of tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input?.uri?.toString() === uriString) {
            tabsToClose.push(tab)
          }
        }
      }

      if (tabsToClose.length > 0) {
        await tabGroups.close(tabsToClose, true)
        return
      }
    }

    const activeEditor = vscode.window.activeTextEditor
    if (activeEditor?.document?.uri.toString() === uriString) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    }
  }

  async acceptFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const uriString = file.uri.toString()
    const document = await safeOpenDocument(uriString)
    await this.setSessionBaselineText(uriString, document ? document.getText() : '')
    this.session.reviewFiles.delete(uriString)
    this.session.touchedUris.delete(uriString)
    this.markReviewDataChanged()

    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(uriString)
    if (document) {
      await this.saveReviewDocument(file.uri)
    }
    await this.maybeAutoComplete()
  }

  async rejectFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const baselineText = await this.getSessionBaselineText(file.uri.toString())
    const shouldDeleteFile = this.hasSessionMissingBaseline(file.uri.toString())
    const applied = await this.rejectUriToBaseline(file.uri, baselineText)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject file.')
      return
    }

    if (shouldDeleteFile) {
      await this.finishRejectedMissingFile(file.uri)
    } else {
      await this.refreshChangedReviewFile(file.uri)
    }
    await this.refreshReviewPanel()
  }

  async refreshChangedReviewFile(uri) {
    if (!this.session || !uri) {
      return
    }

    const uriString = uri.toString()
    const document = await safeOpenDocument(uriString)
    await this.rebuildFile(uriString, document)
    this.dirtyWorkspaceUris.delete(uriString)
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(uriString)
    await this.maybeAutoComplete()
  }

  async acceptAllFiles() {
    if (!this.session || this.state !== 'reviewing') {
      return
    }

    const uris = [...this.session.reviewFiles.values()].map((file) => file.uri)
    for (const uri of uris) {
      await this.saveReviewDocument(uri)
    }

    await this.completeReview('All remaining review files were skipped.')
  }

  async rejectAllFiles() {
    if (!this.session || this.state !== 'reviewing') {
      return
    }

    for (const file of this.session.reviewFiles.values()) {
      const baselineText = await this.getSessionBaselineText(file.uri.toString())
      const applied = await this.rejectUriToBaseline(file.uri, baselineText)
      if (!applied) {
        void vscode.window.showWarningMessage(`Failed to reject ${toWorkspaceLabel(file.uri)}.`)
        return
      }
    }

    await this.completeReview('All remaining review files were rejected.')
  }

  findFileItem(item) {
    if (!this.session || !item || item.kind !== 'file') {
      return null
    }

    return this.session.reviewFiles.get(item.uri.toString()) ?? null
  }

  findBlockItem(item) {
    if (!this.session || !item || item.kind !== 'block') {
      return null
    }

    const file = this.session.reviewFiles.get(item.uri.toString())
    if (!file) {
      return null
    }

    let block = file.blocks.find((candidate) => candidate.id === item.blockId)
    if (!block) {
      block = findBestMatchingBlock(file.blocks, item)
      if (block) {
        syncReviewItem(item, createReviewItem(file.uri, block))
      }
    }

    if (!block) {
      return null
    }

    return {
      uri: file.uri,
      block
    }
  }

  async maybeAutoComplete() {
    if (this.state !== 'reviewing') {
      return
    }

    if (this.getPendingBlockCount() === 0) {
      await this.completeReview('All review blocks have been handled. Session closed.')
    }
  }

  async showReviewPanel(item) {
    const block = this.findBlockItem(item)
    if (!block) {
      void vscode.window.showInformationMessage('Could not open review panel for this block.')
      return
    }

    if (!this.reviewPanelState) {
      const panel = vscode.window.createWebviewPanel(
        'codexReview.reviewPanel',
        'Code Block Review Panel',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      )

      this.reviewPanelState = {
        panel,
        currentItem: null,
        fallbackBlock: null,
        sourceViewColumn: this.getPreferredSourceViewColumn(),
        acknowledgedPendingKeys: new Set(this.getOrderedPendingBlockItems().map((item) => getReviewItemKey(item))),
        unseenPendingKeys: new Set()
      }

      panel.onDidDispose(() => {
        this.reviewPanelState = null
      }, null, this.context.subscriptions)

      panel.webview.onDidReceiveMessage(async (message) => {
        if (!this.reviewPanelState || !this.reviewPanelState.currentItem) {
          return
        }

        if (message.type === 'previous') {
          const previousItem = this.getAdjacentPendingBlockItem(this.reviewPanelState.currentItem, -1)
          if (previousItem) {
            this.reviewPanelState.currentItem = previousItem
            await this.safeRevealReviewBlock(previousItem)
            await this.refreshReviewPanel()
          }
          return
        }

        if (message.type === 'next') {
          const nextItem = this.getAdjacentPendingBlockItem(this.reviewPanelState.currentItem, 1)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
            await this.safeRevealReviewBlock(nextItem)
            await this.refreshReviewPanel()
          }
          return
        }

        if (message.type === 'accept-file') {
          const activeItem = this.reviewPanelState.currentItem
          const block = this.findBlockItem(activeItem)
          if (!block) {
            return
          }

          const nextItem = this.getNextPendingFileFirstItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.acceptFile({
            kind: 'file',
            uri: block.uri
          })
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }

        if (message.type === 'accept-all-files') {
          await this.acceptAllFiles()
          return
        }

        if (message.type === 'reject-file') {
          const activeItem = this.reviewPanelState.currentItem
          const block = this.findBlockItem(activeItem)
          if (!block) {
            return
          }

          const nextItem = this.getNextPendingFileFirstItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.rejectFile({
            kind: 'file',
            uri: block.uri
          })
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }

        if (message.type === 'reject-all-files') {
          await this.rejectAllFiles()
          return
        }

        if (message.type === 'accept') {
          const activeItem = this.reviewPanelState.currentItem
          const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(activeItem)
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.acceptBlock(activeItem)
          await this.closeDeletedFilePreviewEditors(deletedPreviewUri)
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }

        if (message.type === 'reject') {
          const activeItem = this.reviewPanelState.currentItem
          const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(activeItem)
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.rejectBlock(activeItem)
          await this.closeDeletedFilePreviewEditors(deletedPreviewUri)
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }
      }, null, this.context.subscriptions)
    }

    this.reviewPanelState.currentItem = item
    this.reviewPanelState.fallbackBlock = cloneBlockForPreview(block)
    this.reviewPanelState.sourceViewColumn = this.getPreferredSourceViewColumn()
    this.markReviewItemSeen(item)
    this.reviewPanelState.panel.title = `Code Block Review: ${formatBlockLabel(block.block)}`
    this.reviewPanelState.panel.webview.html = createReviewPanelLoadingHtml(this.reviewPanelState.fallbackBlock)
    this.reviewPanelState.panel.reveal(vscode.ViewColumn.Beside, true)
    await this.safeRevealReviewBlock(item)
    await this.refreshReviewPanel()
  }

  async refreshReviewPanel() {
    if (!this.reviewPanelState) {
      return
    }

    const profile = this.profiler.startMark('refreshReviewPanel')
    const currentItem = this.reviewPanelState.currentItem
    const currentBlock = currentItem ? this.findBlockItem(currentItem) : null
    const previewData = currentBlock
      ? cloneBlockForPreview(currentBlock)
      : this.reviewPanelState.fallbackBlock
    const navigation = currentItem
      ? this.getPendingBlockNavigation(currentItem)
      : {
          currentIndex: 0,
          total: 0,
          hasPrevious: false,
          hasNext: false
        }

    if (currentBlock) {
      this.markReviewItemSeen(createReviewItem(currentBlock.uri, currentBlock.block))
    }

    const newPendingCount = this.updateReviewPanelPendingNoticeState(currentBlock)

    try {
      if (!previewData) {
        this.reviewPanelState.panel.webview.html = createReviewPanelUnavailableHtml()
        return
      }

      if (!currentBlock && navigation.total > 0) {
        const fallbackItem = this.getOrderedPendingBlockItems()[0]
        if (fallbackItem) {
          this.reviewPanelState.currentItem = fallbackItem
          await this.safeRevealReviewBlock(fallbackItem)
          await this.refreshReviewPanel()
          return
        }
      }

      if (currentBlock) {
        this.reviewPanelState.fallbackBlock = previewData
        this.reviewPanelState.panel.title = `Code Block Review: ${formatBlockLabel(currentBlock.block)}`
      } else {
        this.reviewPanelState.panel.title = 'Code Block Review: Handled Block'
      }

      this.reviewPanelState.panel.webview.html = createReviewPanelHtml(previewData, Boolean(currentBlock), navigation, newPendingCount)
    } finally {
      this.profiler.finishMark(profile, {
        hasLiveBlock: currentBlock ? 'true' : 'false',
        navigationTotal: navigation.total
      })
    }
  }

  disposeReviewPanel() {
    if (!this.reviewPanelState) {
      return
    }

    this.reviewPanelState.panel.dispose()
    this.reviewPanelState = null
  }

  getOrderedPendingBlockItems() {
    if (!this.session) {
      return []
    }

    if (this.cachedPendingItemsVersion === this.reviewDataVersion) {
      return this.cachedPendingItems
    }

    const items = []
    for (const file of this.getFiles()) {
      for (const block of file.blocks) {
        if (block.status !== 'pending') {
          continue
        }

        items.push({
          ...createReviewItem(file.uri, block)
        })
      }
    }

    this.cachedPendingItems = items
    this.cachedPendingItemsVersion = this.reviewDataVersion
    return this.cachedPendingItems
  }

  getPendingBlockNavigation(currentItem) {
    const items = this.getOrderedPendingBlockItems()
    const currentIndex = items.findIndex((item) => (
      item.uri.toString() === currentItem.uri.toString() &&
      item.blockId === currentItem.blockId
    ))

    return {
      currentIndex: currentIndex >= 0 ? currentIndex + 1 : 0,
      total: items.length,
      hasPrevious: currentIndex > 0,
      hasNext: currentIndex >= 0 && currentIndex < items.length - 1
    }
  }

  getAdjacentPendingBlockItem(currentItem, direction) {
    const items = this.getOrderedPendingBlockItems()
    const currentIndex = items.findIndex((item) => (
      item.uri.toString() === currentItem.uri.toString() &&
      item.blockId === currentItem.blockId
    ))

    if (currentIndex < 0) {
      return null
    }

    const targetIndex = currentIndex + direction
    if (targetIndex < 0 || targetIndex >= items.length) {
      return null
    }

    return items[targetIndex]
  }

  getPreferredNextReviewItem(currentItem) {
    return this.getAdjacentPendingBlockItem(currentItem, 1) ?? this.getAdjacentPendingBlockItem(currentItem, -1)
  }

  getNextPendingFileFirstItem(currentItem) {
    if (!currentItem?.uri || !this.session) {
      return this.getOrderedPendingBlockItems()[0] ?? null
    }

    const files = this.getFiles()
      .map((file) => ({
        file,
        firstPendingBlock: file.blocks.find((block) => block.status === 'pending') ?? null
      }))
      .filter((entry) => entry.firstPendingBlock)

    if (files.length === 0) {
      return null
    }

    const currentFileIndex = files.findIndex((entry) => entry.file.uri.toString() === currentItem.uri.toString())
    if (currentFileIndex < 0) {
      return createReviewItem(files[0].file.uri, files[0].firstPendingBlock)
    }

    for (let index = currentFileIndex + 1; index < files.length; index += 1) {
      const entry = files[index]
      if (entry.firstPendingBlock) {
        return createReviewItem(entry.file.uri, entry.firstPendingBlock)
      }
    }

    for (let index = 0; index < currentFileIndex; index += 1) {
      const entry = files[index]
      if (entry.firstPendingBlock) {
        return createReviewItem(entry.file.uri, entry.firstPendingBlock)
      }
    }

    return null
  }

  getPreferredSourceViewColumn() {
    if (vscode.window.activeTextEditor?.viewColumn) {
      return vscode.window.activeTextEditor.viewColumn
    }

    return this.reviewPanelState?.sourceViewColumn ?? vscode.ViewColumn.One
  }

  markReviewItemSeen(item) {
    if (!this.reviewPanelState || !item || item.kind !== 'block') {
      return
    }

    const key = getReviewItemKey(item)
    if (!key) {
      return
    }

    this.reviewPanelState.acknowledgedPendingKeys.add(key)
    this.reviewPanelState.unseenPendingKeys.delete(key)
  }

  updateReviewPanelPendingNoticeState(currentBlockInfo) {
    if (!this.reviewPanelState) {
      return 0
    }

    const currentPendingKeys = new Set(this.getOrderedPendingBlockItems().map((item) => getReviewItemKey(item)))
    const currentKey = currentBlockInfo ? getReviewBlockKey(currentBlockInfo.uri, currentBlockInfo.block) : null

    for (const key of [...this.reviewPanelState.unseenPendingKeys]) {
      if (!currentPendingKeys.has(key)) {
        this.reviewPanelState.unseenPendingKeys.delete(key)
      }
    }

    for (const key of currentPendingKeys) {
      if (key === currentKey) {
        this.reviewPanelState.acknowledgedPendingKeys.add(key)
        this.reviewPanelState.unseenPendingKeys.delete(key)
        continue
      }

      if (!this.reviewPanelState.acknowledgedPendingKeys.has(key)) {
        this.reviewPanelState.unseenPendingKeys.add(key)
      }
    }

    return this.reviewPanelState.unseenPendingKeys.size
  }

  async revealReviewBlock(item, options = {}) {
    const block = this.findBlockItem(item)
    if (!block) {
      this.refreshAllVisibleEditors()
      return
    }

    const source = await this.openReviewSourceDocument(block)
    const document = source.document
    const sourceViewColumn = this.reviewPanelState?.sourceViewColumn ?? this.getPreferredSourceViewColumn()
    let editor = vscode.window.visibleTextEditors.find((candidate) => (
      candidate.document.uri.toString() === document.uri.toString() &&
      candidate.viewColumn === sourceViewColumn
    ))

    if (!editor) {
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: sourceViewColumn,
        preview: false,
        preserveFocus: options.preserveFocus ?? true
      })
    }

    const range = this.getSourceRangeForBlock(document, block.block, source.isDeletedFilePreview)
    if (range) {
      editor.selection = new vscode.Selection(range.start, range.start)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    }
    this.refreshAllVisibleEditors()
  }

  async safeRevealReviewBlock(item, options = {}) {
    try {
      await this.revealReviewBlock(item, options)
    } catch (error) {
      console.error('Code Block Review: failed to reveal review block', error)
    }
  }

  updateStatusBar() {
    if (this.state === 'capturing' && this.session) {
      if (this.sessionMode === 'auto' && this.autoCaptureReviewPending) {
        this.statusBarItem.text = `$(diff) Code Block Review: ${this.getPendingBlockCount()} Ready`
        this.statusBarItem.command = 'codexReview.enterReadyReview'
        this.statusBarItem.tooltip = 'Open review now. If you do nothing, this automatic capture will be dismissed after a short grace period and the current workspace will become the new baseline.'
        this.statusBarItem.show()
        return
      }

      this.statusBarItem.text = `$(record) Code Block Review: Capturing ${this.session.touchedUris.size}`
      this.statusBarItem.command = 'codexReview.stopSession'
      this.statusBarItem.tooltip = this.sessionMode === 'auto'
        ? 'Open review mode for this automatic capture'
        : 'Stop capture and enter review mode'
      this.statusBarItem.show()
      return
    }

    if (this.state === 'reviewing') {
      this.statusBarItem.text = `$(diff) Code Block Review: ${this.getPendingBlockCount()} Pending`
      this.statusBarItem.command = 'codexReview.openReviewPanel'
      this.statusBarItem.tooltip = 'Open the Code Block Review Panel'
      this.statusBarItem.show()
      return
    }

    if (this.autoCaptureSettings.enabled && this.autoCaptureState === 'armed') {
      this.statusBarItem.text = this.getAutoCaptureStatusBarText()
      this.statusBarItem.command = 'codexReview.startSession'
      this.statusBarItem.tooltip = [
        'Automatic capture is continuously monitoring for short bursts of large or bulk edits.',
        this.getAutoCaptureBaselineStatusTooltip()
      ].filter(Boolean).join('\n')
      this.statusBarItem.show()
      return
    }

    this.statusBarItem.text = '$(sparkle) Code Block Review: Start'
    this.statusBarItem.command = 'codexReview.startSession'
    this.statusBarItem.tooltip = 'Start a review capture session'
    this.statusBarItem.show()
  }

  getAutoCaptureStatusBarText() {
    if (this.autoCaptureBaselineRefreshPromise || this.autoCaptureBaselineStatus === 'syncing') {
      return '$(sync~spin) Code Block Review: Baseline Syncing'
    }

    if (this.autoCaptureBaselineStatus === 'failed') {
      return '$(warning) Code Block Review: Baseline Failed'
    }

    if (this.autoCaptureBaselineEntriesByUri.size === 0) {
      return '$(pulse) Code Block Review: Baseline Pending'
    }

    return '$(pulse) Code Block Review: Auto Armed'
  }

  getAutoCaptureBaselineStatusTooltip() {
    if (this.autoCaptureBaselineStatusMessage) {
      return this.autoCaptureBaselineStatusMessage
    }

    if (this.autoCaptureBaselineEntriesByUri.size > 0) {
      return `Auto-capture baseline is ready with ${this.autoCaptureBaselineEntriesByUri.size} files.`
    }

    return 'Auto-capture baseline has not finished syncing yet.'
  }

  async syncContexts() {
    await vscode.commands.executeCommand('setContext', 'codexReview.isCapturing', this.state === 'capturing')
    await vscode.commands.executeCommand('setContext', 'codexReview.isReviewing', this.state === 'reviewing')
    await vscode.commands.executeCommand('setContext', 'codexReview.hasSession', this.state !== 'idle')
    await vscode.commands.executeCommand('setContext', 'codexReview.isAutoArmed', this.autoCaptureSettings.enabled && this.autoCaptureState === 'armed')
  }

  clearDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.pendingAddedDecoration, [])
      editor.setDecorations(this.pendingDeletedBaselineDecoration, [])
      editor.setDecorations(this.deletedFilePreviewDecoration, [])
      editor.setDecorations(this.pendingModifiedDecoration, [])
      editor.setDecorations(this.currentReviewDecoration, [])
      editor.setDecorations(this.acceptedDecoration, [])
    }
  }

  refreshAllVisibleEditors() {
    if (this.visibleEditorsRefreshTimer) {
      return
    }

    this.visibleEditorsRefreshTimer = setTimeout(() => {
      this.visibleEditorsRefreshTimer = null
      this.flushVisibleEditorsRefresh()
    }, 16)
  }

  flushVisibleEditorsRefresh() {
    if (this.state !== 'reviewing' || !this.session) {
      this.clearDecorations()
      return
    }

    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  }

  refreshDecorationsForUri(uriString) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uriString) {
        this.refreshEditor(editor)
      }
    }
  }

  refreshEditor(editor) {
    if (editor.document.uri.scheme === DELETED_FILE_PREVIEW_SCHEME) {
      this.refreshDeletedFilePreviewEditor(editor)
      return
    }

    const pendingAddedOptions = []
    const pendingDeletedBaselineOptions = []
    const pendingModifiedOptions = []
    const currentReviewOptions = []
    const acceptedOptions = []
    const decorationOptions = {
      showBadge: Boolean(vscode.workspace.getConfiguration('codexReview').get('showBlockBadges', false))
    }

    if (this.session) {
      const file = this.session.reviewFiles.get(editor.document.uri.toString())
      if (file) {
        for (const block of file.blocks) {
          const range = getRangeForBlock(editor.document, block)
          if (!range) {
            continue
          }

          if (block.status === 'accepted') {
            acceptedOptions.push(createDecorationOption(range, file.label, block, 'accepted', decorationOptions))
          } else if (block.status === 'pending') {
            if (block.changeKind === 'addition') {
              pendingAddedOptions.push(createDecorationOption(range, file.label, block, 'pending', decorationOptions))
            } else if (block.changeKind === 'deletion') {
              const deletedBaselineOption = createDeletedBaselineDecorationOption(editor.document, file.label, block)
              if (deletedBaselineOption) {
                pendingDeletedBaselineOptions.push(deletedBaselineOption)
              }
            } else {
              pendingModifiedOptions.push(createDecorationOption(range, file.label, block, 'pending', decorationOptions))
            }
          }

          if (
            this.reviewPanelState &&
            this.reviewPanelState.currentItem &&
            this.reviewPanelState.currentItem.uri.toString() === file.uri.toString() &&
            this.reviewPanelState.currentItem.blockId === block.id
          ) {
            currentReviewOptions.push({
              range,
              hoverMessage: new vscode.MarkdownString('Currently selected in Code Block Review Panel')
            })
          }
        }
      }
    }

    editor.setDecorations(this.pendingAddedDecoration, pendingAddedOptions)
    editor.setDecorations(this.pendingDeletedBaselineDecoration, pendingDeletedBaselineOptions)
    editor.setDecorations(this.pendingModifiedDecoration, pendingModifiedOptions)
    editor.setDecorations(this.currentReviewDecoration, currentReviewOptions)
    editor.setDecorations(this.acceptedDecoration, acceptedOptions)
  }

  refreshDeletedFilePreviewEditor(editor) {
    editor.setDecorations(this.pendingAddedDecoration, [])
    editor.setDecorations(this.pendingDeletedBaselineDecoration, [])
    editor.setDecorations(this.pendingModifiedDecoration, [])
    editor.setDecorations(this.currentReviewDecoration, [])
    editor.setDecorations(this.acceptedDecoration, [])

    const fullPreviewOptions = []
    for (let line = 0; line < editor.document.lineCount; line += 1) {
      fullPreviewOptions.push({
        range: editor.document.lineAt(line).range
      })
    }

    editor.setDecorations(this.deletedFilePreviewDecoration, fullPreviewOptions)
  }
}

module.exports = {
  activate,
  deactivate
}
