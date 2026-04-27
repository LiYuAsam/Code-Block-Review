const vscode = require('vscode')
const AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS = 'windowFocus'
const AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE = 'activeEditorChange'
const GIT_ACTIVITY_SUPPRESSION_WINDOW_MS = 4000
const WORKSPACE_RESCAN_DEBOUNCE_MS = 200
const LARGE_REVIEW_SESSION_PENDING_BLOCK_WARNING = 200
const LARGE_REVIEW_SESSION_TEXT_WARNING_BYTES = 5 * 1024 * 1024
const LARGE_REVIEW_SESSION_SNAPSHOT_WARNING_BYTES = 20 * 1024 * 1024
const {
  clearIgnoredReviewGlobsCache,
  countUniqueTouchedLinesAcrossFiles,
  filterTrackableUris,
  getAutoCaptureSettings,
  getCurrentTrackedText,
  hashText,
  isTrackableDocument,
  isTrackableUri,
  isUndoOrRedoChange,
  readTrackedTextFromUri,
  summarizeAutoCaptureEvent,
  summarizeTextDelta,
  uriExists
} = require('./review-model')
const {
  ReviewBlockCodeLensProvider,
  ReviewTreeProvider
} = require('./ui/review-tree')
const {
  DELETED_FILE_PREVIEW_SCHEME,
  deletedPreviewControllerMethods
} = require('./controller/deleted-preview')
const { decorationControllerMethods } = require('./controller/decorations')
const { reviewActionControllerMethods } = require('./controller/review-actions')
const { reviewPanelControllerMethods } = require('./controller/review-panel-controller')
const { sessionControllerMethods } = require('./controller/session')
const { statusControllerMethods } = require('./controller/status')
const { workspaceScanControllerMethods } = require('./controller/workspace-scan')
const {
  cleanupSnapshotDirectory,
  cleanupSnapshotFiles,
  cloneBaselineEntries,
  createAutoCaptureBaselineSnapshotDirectory,
  persistBaselineText,
  readBaselineEntryText
} = require('./utils/baseline-snapshots')
const { createReviewDecorations } = require('./ui/decorations')
const { pluralKey, t } = require('./utils/i18n')
const { ReviewProfiler } = require('./utils/profiler')
const {
  WORKSPACE_EXCLUDE_GLOB,
  WORKSPACE_INCLUDE_GLOB,
  findNearestProjectRoot,
  getActiveWorkspaceFolder,
  getWorkspaceBaselineKey,
  getWorkspaceKeyForUri,
  isGitMetadataUri,
  readGitRepositoryStateForRoot,
  readGitRepositoryStateForUri
} = require('./utils/workspace')

const activeControllers = new Set()

function activate(context) {
  const controller = new ReviewController(context)
  activeControllers.add(controller)
  context.subscriptions.push(controller)
}

function deactivate() {
  return Promise.all([...activeControllers].map((controller) => controller.dispose()))
}

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
    this.autoCaptureLargeSessionWarningShown = false
    this.autoCaptureSettings = getAutoCaptureSettings()
    this.disposePromise = null
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
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.disposePromise = this.disposeAsync()
    return this.disposePromise
  }

  async disposeAsync() {
    this.clearAutoCaptureTimers()
    this.clearWorkspaceRescanTimer()
    this.clearAutoCaptureFilesystemProbeTimer()
    this.clearVisibleEditorsRefreshTimer()
    this.disposeWorkspaceWatchers()
    this.disposeReviewPanel()
    this.clearDecorations()

    try {
      if (this.autoCaptureBaselineRefreshPromise) {
        await this.autoCaptureBaselineRefreshPromise.catch(() => {})
      }
      await Promise.all([
        this.cleanupAutoCaptureBaselineSnapshots(),
        this.cleanupSessionBaselineSnapshots()
      ])
    } finally {
      activeControllers.delete(this)
    }
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

  // Rebuilds the idle auto-capture baseline used to detect future generated edit bursts.
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

        const staleSnapshotPaths = collectStaleSnapshotPaths(
          this.autoCaptureBaselineEntriesByUri,
          nextEntriesByUri
        )
        this.autoCaptureBaselineEntriesByUri = nextEntriesByUri
        await cleanupSnapshotFiles(staleSnapshotPaths)
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

  // Clears the armed auto-capture state and releases its baseline snapshots.
  resetAutoCaptureArmedState() {
    this.clearAutoReviewOfferTimer()
    this.clearAutoObservationTimer()
    this.autoCaptureState = 'idle'
    this.autoCaptureBaselineEntriesByUri = new Map()
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureReviewPending = false
    this.autoCaptureLargeSessionWarningShown = false
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

  // Arms auto capture and refreshes its baseline when settings or workspace context require it.
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

  // Responds to focus/editor triggers that are allowed to prepare auto capture.
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
      this.autoCaptureLargeSessionWarningShown = false
    }
    this.bumpAutoCaptureStopTimer()
  }

  scheduleAutoReviewOfferTimer() {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
      return
    }

    this.clearAutoReviewOfferTimer()
    if (this.autoCaptureSettings.reviewOfferMs <= 0) {
      return
    }

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
    const suffix = this.autoCaptureSettings.reviewOfferMs <= 0
      ? t('message.autoDismissDisabledSuffix')
      : ''
    const startReviewAction = t('action.startReview')
    const skipAction = t('action.skip')
    const pendingCount = this.getPendingBlockCount()
    void vscode.window.showInformationMessage(
      t('message.autoCaptured', {
        count: pendingCount,
        blockWord: pluralKey(pendingCount, 'unit.block.singular', 'unit.block.plural'),
        suffix
      }),
      startReviewAction,
      skipAction
    ).then((selection) => {
      if (promptNonce !== this.autoCaptureReviewPromptNonce) {
        return
      }

      if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
        return
      }

      if (selection === startReviewAction) {
        void this.enterReadyReviewAndOpenFirstPendingBlock()
        return
      }

      if (selection === skipAction) {
        void this.completeReview(null, { silent: true })
      }
    })
  }

  async maybeWarnLargeAutoReviewSession() {
    if (
      this.autoCaptureLargeSessionWarningShown ||
      this.sessionMode !== 'auto' ||
      this.state !== 'capturing' ||
      !this.autoCaptureReviewPending ||
      !this.session
    ) {
      return
    }

    const estimate = await this.estimateReviewSessionSize()
    const warningReasons = []
    if (estimate.pendingBlocks >= LARGE_REVIEW_SESSION_PENDING_BLOCK_WARNING) {
      warningReasons.push(t('unit.pendingBlocks', { count: estimate.pendingBlocks }))
    }
    if (estimate.reviewTextBytes >= LARGE_REVIEW_SESSION_TEXT_WARNING_BYTES) {
      warningReasons.push(t('unit.reviewText', { size: formatByteCount(estimate.reviewTextBytes) }))
    }
    if (estimate.snapshotBytes >= LARGE_REVIEW_SESSION_SNAPSHOT_WARNING_BYTES) {
      warningReasons.push(t('unit.snapshots', { size: formatByteCount(estimate.snapshotBytes) }))
    }

    if (warningReasons.length === 0) {
      return
    }

    this.autoCaptureLargeSessionWarningShown = true
    const startReviewAction = t('action.startReview')
    const skipAction = t('action.skip')
    void vscode.window.showWarningMessage(
      t('message.largeSessionWarning', { reasons: warningReasons.join(', ') }),
      startReviewAction,
      skipAction
    ).then((selection) => {
      if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
        return
      }

      if (selection === startReviewAction) {
        void this.enterReadyReviewAndOpenFirstPendingBlock()
        return
      }

      if (selection === skipAction) {
        void this.completeReview(null, { silent: true })
      }
    })
  }

  async estimateReviewSessionSize() {
    const estimate = {
      pendingBlocks: 0,
      reviewTextBytes: 0,
      snapshotBytes: 0
    }

    if (!this.session) {
      return estimate
    }

    for (const file of this.session.reviewFiles.values()) {
      for (const block of file.blocks) {
        if (block.status !== 'pending') {
          continue
        }

        estimate.pendingBlocks += 1
        estimate.reviewTextBytes += Buffer.byteLength(block.originalText || '', 'utf8')
        estimate.reviewTextBytes += Buffer.byteLength(block.modifiedText || '', 'utf8')
      }
    }

    const snapshotPaths = new Set()
    for (const entry of this.session.baselineEntriesByUri.values()) {
      if (entry?.kind === 'snapshot' && entry.snapshotPath) {
        snapshotPaths.add(entry.snapshotPath)
      }
    }

    for (const snapshotPath of snapshotPaths) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(snapshotPath))
        estimate.snapshotBytes += stat.size
      } catch {}
    }

    return estimate
  }

  async completeAutoReadySessionIfEmpty(message = null) {
    if (this.sessionMode !== 'auto' || this.state !== 'capturing' || !this.autoCaptureReviewPending) {
      return false
    }

    if (this.getPendingBlockCount() > 0) {
      return false
    }

    await this.completeReview(message, { silent: true })
    return true
  }

  async captureSessionGitStates() {
    const statesByRoot = new Map()
    const sourceUris = []

    if (this.session) {
      for (const uriString of this.session.baselineEntriesByUri.keys()) {
        sourceUris.push(uriString)
      }
      for (const uriString of this.session.touchedUris) {
        sourceUris.push(uriString)
      }
      for (const file of this.session.reviewFiles.values()) {
        sourceUris.push(file.uri.toString())
      }
    }

    for (const document of vscode.workspace.textDocuments) {
      if (isTrackableDocument(document)) {
        sourceUris.push(document.uri.toString())
      }
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      sourceUris.push(folder.uri.toString())
    }

    const seenUris = new Set()
    for (const uriString of sourceUris) {
      if (!uriString || seenUris.has(uriString)) {
        continue
      }
      seenUris.add(uriString)

      let uri = null
      try {
        uri = vscode.Uri.parse(uriString)
      } catch {
        continue
      }

      const state = await readGitRepositoryStateForUri(uri)
      if (state && !statesByRoot.has(state.repoRoot)) {
        statesByRoot.set(state.repoRoot, state)
      }
    }

    return statesByRoot
  }

  async handleSessionGitStateChange(reason) {
    if (
      this.state !== 'capturing' ||
      !this.session ||
      !this.session.gitStatesByRoot ||
      this.session.gitStatesByRoot.size === 0
    ) {
      return false
    }

    for (const [repoRoot, previousState] of this.session.gitStatesByRoot.entries()) {
      let currentState = null
      try {
        currentState = await readGitRepositoryStateForRoot(vscode.Uri.parse(repoRoot))
      } catch {}

      if (currentState?.signature === previousState.signature) {
        continue
      }

      const wasAutoSession = this.sessionMode === 'auto'
      this.profiler.logSnapshot('gitStateChanged:releaseSession', {
        reason,
        repoRoot
      })
      await this.completeReview(
        t('message.gitStateChanged'),
        { silent: wasAutoSession }
      )
      return true
    }

    return false
  }

  // Records edit burst evidence that may later cross the auto-capture threshold.
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

  // Decides whether accumulated edit evidence is strong enough to start an auto session.
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
      if (this.session) {
        this.scheduleWorkspaceRescan(`git-${kind}`, 0)
      }
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
    if (await this.completeAutoReadySessionIfEmpty()) {
      return
    }

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

  // Promotes the armed baseline and collected evidence into a real auto capture session.
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

  // Fast path from a document change event into auto capture when no session is active.
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

}

Object.assign(
  ReviewController.prototype,
  deletedPreviewControllerMethods,
  decorationControllerMethods,
  reviewActionControllerMethods,
  reviewPanelControllerMethods,
  sessionControllerMethods,
  workspaceScanControllerMethods,
  statusControllerMethods
)

function formatByteCount(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function collectStaleSnapshotPaths(previousEntriesByUri, nextEntriesByUri) {
  const nextSnapshotPaths = new Set()
  for (const entry of nextEntriesByUri.values()) {
    if (entry?.kind === 'snapshot' && entry.snapshotPath) {
      nextSnapshotPaths.add(entry.snapshotPath)
    }
  }

  const staleSnapshotPaths = new Set()
  for (const entry of previousEntriesByUri.values()) {
    if (
      entry?.kind === 'snapshot' &&
      entry.snapshotPath &&
      !nextSnapshotPaths.has(entry.snapshotPath)
    ) {
      staleSnapshotPaths.add(entry.snapshotPath)
    }
  }

  return staleSnapshotPaths
}

module.exports = {
  activate,
  deactivate
}
