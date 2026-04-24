const vscode = require('vscode')
const crypto = require('crypto')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const WORKSPACE_INCLUDE_GLOB = '**/*'
const WORKSPACE_EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,out,.next,.turbo,.cache,coverage}/**'
const AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS = 'windowFocus'
const AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE = 'activeEditorChange'
const GIT_ACTIVITY_SUPPRESSION_WINDOW_MS = 4000
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
  createReviewPanelHtml,
  createReviewPanelLoadingHtml,
  createReviewPanelUnavailableHtml,
  getRangeForBlock
} = require('./review-ui')
const {
  ReviewBlockCodeLensProvider,
  ReviewTreeProvider
} = require('./review-tree')

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
    this.profilerOutput = vscode.window.createOutputChannel('Code Block Review Profiler')
    this.profilerEnabled = this.getProfilerEnabled()
    this.profilerOutputShown = false
    this.lastAutoCaptureBaselineRefreshAt = 0
    this.dirtyWorkspaceUris = new Set()
    this.recentGitActivityByWorkspaceKey = new Map()
    this.autoCaptureBaselineWorkspaceKey = this.getWorkspaceBaselineKey()
    this.autoCaptureBaselineEntriesByUri = new Map()
    this.autoCaptureBaselineSnapshotDirectory = null
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureFilesystemProbeUris = new Set()
    this.autoCaptureReviewPending = false
    this.autoCaptureReviewPromptNonce = 0
    this.autoCaptureSettings = getAutoCaptureSettings()
    this.initializeWorkspaceWatchers()

    this.treeProvider = new ReviewTreeProvider(this)
    this.blockActionProvider = new ReviewBlockCodeLensProvider(this)
    this.pendingAddedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(45, 211, 111, 0.12)',
      borderColor: 'rgba(45, 211, 111, 0.80)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(45, 211, 111, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.pendingDeletedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(239, 68, 68, 0.12)',
      borderColor: 'rgba(239, 68, 68, 0.82)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(239, 68, 68, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.pendingModifiedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(34, 197, 94, 0.10)',
      borderColor: 'rgba(34, 197, 94, 0.82)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(34, 197, 94, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.currentReviewDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(250, 204, 21, 0.18)',
      borderColor: 'rgba(250, 204, 21, 0.95)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 4px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(250, 204, 21, 0.95)',
      overviewRulerLane: vscode.OverviewRulerLane.Center
    })
    this.acceptedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(94, 234, 212, 0.08)',
      borderColor: 'rgba(94, 234, 212, 0.40)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(94, 234, 212, 0.55)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)

    context.subscriptions.push(
      this.pendingAddedDecoration,
      this.pendingDeletedDecoration,
      this.pendingModifiedDecoration,
      this.currentReviewDecoration,
      this.acceptedDecoration,
      this.statusBarItem,
      this.profilerOutput,
      vscode.window.registerTreeDataProvider('codexReview.filesView', this.treeProvider),
      vscode.languages.registerCodeLensProvider(
        [
          { scheme: 'file' },
          { scheme: 'untitled' }
        ],
        this.blockActionProvider
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.handleDocumentChange(event)
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
        this.profilerOutput.show(true)
      })
    )

    this.syncContexts()
    this.logProfilerSnapshot('activate')
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
    this.autoCaptureBaselineWorkspaceKey = this.getWorkspaceBaselineKey()

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
    this.profilerEnabled = this.getProfilerEnabled()
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

  shouldRunFullWorkspaceScan(reason) {
    return !reason ||
      reason === 'manual-refresh' ||
      reason === 'final-pass-1' ||
      reason === 'final-pass-2' ||
      reason === 'delete-event'
  }

  buildWorkspaceScanCandidates(currentWorkspaceUris, shouldRunFullScan) {
    if (shouldRunFullScan) {
      const candidateUris = new Map(currentWorkspaceUris)

      for (const document of vscode.workspace.textDocuments) {
        if (isTrackableDocument(document)) {
          candidateUris.set(document.uri.toString(), document.uri)
        }
      }

      for (const uriString of this.session?.baselineEntriesByUri.keys() ?? []) {
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

    for (const uriString of this.dirtyWorkspaceUris) {
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

  getWorkspaceBaselineKey() {
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

  getWorkspaceKeyForUri(uri) {
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : null
    return folder?.uri.toString() ?? null
  }

  getProfilerEnabled() {
    return Boolean(vscode.workspace.getConfiguration('codexReview.profiler').get('enabled', false))
  }

  isGitMetadataUri(uri) {
    if (!uri || uri.scheme !== 'file') {
      return false
    }

    const normalizedPath = uri.fsPath.replace(/\\/g, '/')
    return normalizedPath.endsWith('/.git') || normalizedPath.includes('/.git/')
  }

  markRecentGitActivity(uri) {
    const workspaceKey = this.getWorkspaceKeyForUri(uri)
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
        const workspaceKey = this.getWorkspaceKeyForUri(vscode.Uri.parse(entry.uri))
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

  formatProfilerValue(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(1)
      : '0.0'
  }

  getProfilerSnapshot() {
    const memory = process.memoryUsage()
    return {
      rssMb: memory.rss / (1024 * 1024),
      heapUsedMb: memory.heapUsed / (1024 * 1024),
      heapTotalMb: memory.heapTotal / (1024 * 1024),
      externalMb: memory.external / (1024 * 1024)
    }
  }

  logProfilerSnapshot(label, extra = {}) {
    if (!this.profilerEnabled) {
      return
    }

    const memory = this.getProfilerSnapshot()
    const timestamp = new Date().toISOString()
    const details = Object.entries(extra)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')

    if (!this.profilerOutputShown) {
      this.profilerOutput.show(true)
      this.profilerOutputShown = true
    }

    this.profilerOutput.appendLine(
      `[${timestamp}] ${label} rss=${this.formatProfilerValue(memory.rssMb)}MB heap=${this.formatProfilerValue(memory.heapUsedMb)}/${this.formatProfilerValue(memory.heapTotalMb)}MB external=${this.formatProfilerValue(memory.externalMb)}MB${details ? ` ${details}` : ''}`
    )
  }

  startProfilerMark(label, extra = {}) {
    if (!this.profilerEnabled) {
      return null
    }

    this.logProfilerSnapshot(`${label}:start`, extra)
    return {
      label,
      startedAt: process.hrtime.bigint(),
      cpuUsage: process.cpuUsage()
    }
  }

  finishProfilerMark(mark, extra = {}) {
    if (!mark) {
      return
    }

    const elapsedMs = Number(process.hrtime.bigint() - mark.startedAt) / 1e6
    const cpu = process.cpuUsage(mark.cpuUsage)
    this.logProfilerSnapshot(`${mark.label}:end`, {
      elapsedMs: this.formatProfilerValue(elapsedMs),
      cpuUserMs: this.formatProfilerValue(cpu.user / 1000),
      cpuSystemMs: this.formatProfilerValue(cpu.system / 1000),
      ...extra
    })
  }

  getSessionBaselineEntry(uriString) {
    return this.session?.baselineEntriesByUri.get(uriString) ?? null
  }

  hasSessionBaseline(uriString) {
    return Boolean(this.session?.baselineEntriesByUri.has(uriString))
  }

  async createSessionBaselineSnapshotDirectory() {
    const prefix = path.join(os.tmpdir(), 'codex-review-baseline-')
    return fs.mkdtemp(prefix)
  }

  async ensureAutoCaptureBaselineSnapshotDirectory() {
    if (this.autoCaptureBaselineSnapshotDirectory) {
      return this.autoCaptureBaselineSnapshotDirectory
    }

    const workspaceKey = this.autoCaptureBaselineWorkspaceKey || this.getWorkspaceBaselineKey()
    const rootDirectory = path.join(os.tmpdir(), 'codex-review-auto-baselines', workspaceKey)
    await fs.mkdir(rootDirectory, { recursive: true })
    const snapshotDirectory = await fs.mkdtemp(path.join(rootDirectory, 'armed-'))
    this.autoCaptureBaselineSnapshotDirectory = snapshotDirectory
    return snapshotDirectory
  }

  async cleanupAutoCaptureBaselineSnapshots() {
    const snapshotDirectory = this.autoCaptureBaselineSnapshotDirectory
    if (!snapshotDirectory) {
      return
    }

    this.autoCaptureBaselineSnapshotDirectory = null
    try {
      await fs.rm(snapshotDirectory, { recursive: true, force: true })
    } catch {}
  }

  async cleanupSessionBaselineSnapshots(session = this.session) {
    const snapshotDirectory = session?.baselineSnapshotDirectory
    if (!snapshotDirectory) {
      return
    }

    session.baselineSnapshotDirectory = null
    try {
      await fs.rm(snapshotDirectory, { recursive: true, force: true })
    } catch {}
  }

  async persistSessionBaselineText(uriString, text) {
    if (!this.session) {
      return null
    }

    const snapshotDirectory = this.session.baselineSnapshotDirectory
    if (!snapshotDirectory) {
      return null
    }

    const snapshotPath = path.join(snapshotDirectory, `${hashText(uriString)}-${crypto.randomUUID()}.txt`)
    await fs.writeFile(snapshotPath, text, 'utf8')
    this.session.baselineEntriesByUri.set(uriString, {
      kind: 'snapshot',
      snapshotPath
    })
    return snapshotPath
  }

  async persistAutoCaptureBaselineText(uriString, text) {
    const snapshotDirectory = await this.ensureAutoCaptureBaselineSnapshotDirectory()
    const snapshotPath = path.join(snapshotDirectory, `${hashText(uriString)}-${crypto.randomUUID()}.txt`)
    await fs.writeFile(snapshotPath, text, 'utf8')
    return snapshotPath
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

    this.session.baselineEntriesByUri.set(uriString, { kind: 'empty' })
  }

  async getSessionBaselineText(uriString) {
    if (!this.session) {
      return ''
    }

    const entry = this.session.baselineEntriesByUri.get(uriString)
    if (!entry || entry.kind === 'empty') {
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
      snapshotPath
    })
  }

  deleteAutoCaptureIdleBaseline(uriString) {
    this.autoCaptureBaselineEntriesByUri.delete(uriString)
  }

  async getAutoCaptureIdleBaselineText(uriString) {
    const entry = this.autoCaptureBaselineEntriesByUri.get(uriString)
    if (!entry || entry.kind === 'empty') {
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

  buildAutoCaptureBaselineEntryMap() {
    const baselineEntries = new Map()

    for (const [uriString, entry] of this.autoCaptureBaselineEntriesByUri.entries()) {
      baselineEntries.set(uriString, { ...entry })
    }

    return baselineEntries
  }

  async refreshAutoCaptureBaseline() {
    if (this.autoCaptureBaselineRefreshPromise) {
      return this.autoCaptureBaselineRefreshPromise
    }

    this.autoCaptureBaselineRefreshPromise = (async () => {
      const profile = this.startProfilerMark('refreshAutoCaptureBaseline')
      const nextEntriesByUri = new Map()
      const previousSnapshotDirectory = this.autoCaptureBaselineSnapshotDirectory
      this.autoCaptureBaselineSnapshotDirectory = null

      try {
        for (const document of vscode.workspace.textDocuments) {
          if (isTrackableDocument(document)) {
            const uriString = document.uri.toString()
            const snapshotPath = await this.persistAutoCaptureBaselineText(uriString, document.getText())
            nextEntriesByUri.set(uriString, {
              kind: 'snapshot',
              snapshotPath
            })
          }
        }

        const workspaceFiles = await this.listTrackableWorkspaceFiles()
        for (const uri of workspaceFiles) {
          const key = uri.toString()
          if (nextEntriesByUri.has(key)) {
            continue
          }

          const text = await readTrackedTextFromUri(uri)
          if (text !== null) {
            const snapshotPath = await this.persistAutoCaptureBaselineText(key, text)
            nextEntriesByUri.set(key, {
              kind: 'snapshot',
              snapshotPath
            })
          }
        }

        this.autoCaptureBaselineEntriesByUri = nextEntriesByUri
        this.lastAutoCaptureBaselineRefreshAt = Date.now()
      } finally {
        if (previousSnapshotDirectory) {
          try {
            await fs.rm(previousSnapshotDirectory, { recursive: true, force: true })
          } catch {}
        }
        this.finishProfilerMark(profile, {
          fileCount: nextEntriesByUri.size,
          baselineEntryCount: this.autoCaptureBaselineEntriesByUri.size,
          candidateCount: this.autoCaptureCandidateBaselineByUri.size,
          snapshotDir: this.autoCaptureBaselineSnapshotDirectory ? 'ready' : 'missing'
        })
      }
    })().finally(() => {
      this.autoCaptureBaselineRefreshPromise = null
    })

    return this.autoCaptureBaselineRefreshPromise
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
    void this.cleanupAutoCaptureBaselineSnapshots()
    this.logProfilerSnapshot('resetAutoCaptureArmedState', {
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
    if (!this.autoCaptureCandidateBaselineByUri.has(uriString)) {
      const idleBaselineText = await this.getAutoCaptureIdleBaselineText(uriString)
      this.autoCaptureCandidateBaselineByUri.set(
        uriString,
        idleBaselineText
      )
    }

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
        this.logProfilerSnapshot('autoCaptureSkippedGitLike', {
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
        this.logProfilerSnapshot('autoCaptureSkippedGitLike', {
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
        this.logProfilerSnapshot('autoCaptureSkippedGitLike', {
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
      return
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
    await this.ensureAutoCaptureReady({ silent: true })
    this.updateStatusBar()
    await this.syncContexts()
  }

  async absorbAutoCaptureEvidenceIntoBaseline() {
    if (!this.autoCaptureEvidence.length) {
      return
    }

    const touchedUris = new Set(this.autoCaptureEvidence.map((entry) => entry.uri))
    for (const uriString of touchedUris) {
      const uri = vscode.Uri.parse(uriString)
      const existsInWorkspace = uri.scheme !== 'file' || (await uriExists(uri))
      const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
      if (currentText === null) {
        this.deleteAutoCaptureIdleBaseline(uriString)
        continue
      }

      await this.setAutoCaptureIdleBaselineText(uriString, currentText)
    }

    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
  }

  async absorbCurrentDocumentIntoAutoBaseline(document) {
    if (!document || !isTrackableDocument(document)) {
      return
    }

    const uriString = document.uri.toString()
    await this.setAutoCaptureIdleBaselineText(uriString, document.getText())
    this.autoCaptureCandidateBaselineByUri.delete(uriString)
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

    if (this.isGitMetadataUri(uri)) {
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
      this.scheduleWorkspaceRescan(`watcher-${kind}`)
      return
    }

    if (!this.autoCaptureSettings.enabled) {
      return
    }

    this.scheduleAutoCaptureFilesystemProbe(uri)
  }

  scheduleWorkspaceRescan(reason = 'watcher') {
    this.pendingWorkspaceRescanReason = reason
    if (this.workspaceRescanTimer) {
      return
    }

    this.workspaceRescanTimer = setTimeout(() => {
      this.workspaceRescanTimer = null
      const pendingReason = this.pendingWorkspaceRescanReason ?? 'watcher'
      this.pendingWorkspaceRescanReason = null
      void this.flushScheduledWorkspaceRescan(pendingReason)
    }, 200)
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
      const candidateBaselineText = this.autoCaptureCandidateBaselineByUri.get(uriString)
      const baselineText = typeof candidateBaselineText === 'string'
        ? candidateBaselineText
        : await this.getAutoCaptureIdleBaselineText(uriString)

      if (currentText === null && !this.hasAutoCaptureIdleBaseline(uriString)) {
        this.dropAutoCaptureEvidenceForUri(uriString)
        continue
      }

      if (currentText === baselineText) {
        this.dropAutoCaptureEvidenceForUri(uriString)
        continue
      }

      this.autoCaptureCandidateBaselineByUri.set(uriString, baselineText)
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
      adoptedBaselineSnapshotDirectory
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

    await this.ensureAutoCaptureReady({ silent: true })

    if (this.autoCaptureState !== 'armed' || this.state !== 'idle') {
      return false
    }

    const uriString = event.document.uri.toString()
    const candidateBaselineText = this.autoCaptureCandidateBaselineByUri.get(uriString)
    if (typeof candidateBaselineText === 'string' && event.document.getText() === candidateBaselineText) {
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

    await this.recordAutoCaptureEvidence(event)

    if (this.shouldStartAutoCaptureFromEvidence()) {
      return this.startAutoCaptureFromEvidence()
    }

    this.scheduleAutoCaptureObservationTimeout()
    return false
  }

  async startSession(options = {}) {
    const profile = this.startProfilerMark('startSession', { mode: options.mode ?? 'manual' })
    const {
      mode = 'manual',
      silent = false,
      baselineEntries = null,
      baselineOverrides = null,
      adoptedBaselineSnapshotDirectory = null
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
      const baselineSnapshotDirectory = adoptedBaselineSnapshotDirectory ?? await this.createSessionBaselineSnapshotDirectory()
      this.sessionMode = mode
      this.session = {
        startedAt: new Date().toISOString(),
        baselineEntriesByUri: new Map(),
        baselineSnapshotDirectory,
        touchedUris: new Set(),
        reviewFiles: new Map(),
        finalWorkspaceDiffClean: false
      }
      this.markReviewDataChanged()

      if (baselineEntries instanceof Map) {
        for (const [key, entry] of baselineEntries.entries()) {
          if (entry?.kind === 'snapshot' && entry.snapshotPath) {
            this.session.baselineEntriesByUri.set(key, { ...entry })
          } else if (entry?.kind === 'empty') {
            this.session.baselineEntriesByUri.set(key, { kind: 'empty' })
          }
        }
      }

      if (baselineOverrides instanceof Map) {
        for (const [key, text] of baselineOverrides.entries()) {
          await this.setSessionBaselineText(key, text)
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
      this.finishProfilerMark(profile, {
        baselineEntries: this.session?.baselineEntriesByUri.size ?? 0,
        touchedUris: this.session?.touchedUris.size ?? 0
      })
    }
  }

  async stopSession(options = {}) {
    const profile = this.startProfilerMark('stopSession', { requestedMode: options.requestedMode ?? '' })
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
        this.logProfilerSnapshot('runFinalWorkspaceDiffPass:reused', {
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
      this.finishProfilerMark(profile, {
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
    const profile = this.startProfilerMark('runFinalWorkspaceDiffPass')
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
      this.finishProfilerMark(profile, {
        touchedUris: this.session?.touchedUris.size ?? 0,
        reviewFiles: this.session?.reviewFiles.size ?? 0,
        secondPass: pendingDirtyCount > 0 ? 'dirty-only' : 'skipped',
        dirtyAfterWait: pendingDirtyCount
      })
    } catch (error) {
      this.finishProfilerMark(profile, {
        touchedUris: this.session?.touchedUris.size ?? 0,
        reviewFiles: this.session?.reviewFiles.size ?? 0,
        failed: 'true'
      })
      throw error
    }
  }

  async completeReview(message, options = {}) {
    const profile = this.startProfilerMark('completeReview', { silent: options.silent ? 'true' : 'false' })
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
      this.finishProfilerMark(profile, { state: this.state })
    }
  }

  async refreshReview() {
    if (!this.session) {
      return
    }

    const profile = this.startProfilerMark('refreshReview')
    try {
      await this.scanWorkspaceForChanges('manual-refresh')
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()
      await this.maybeAutoComplete()
    } finally {
      this.finishProfilerMark(profile, {
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
      await this.rebuildFile(uriString, event.document)
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()
      await this.refreshReviewPanel()
      await this.maybeAutoComplete()
      return
    }

    if (this.sessionMode === 'auto') {
      if (this.autoCaptureReviewPending) {
        this.autoCaptureReviewPending = false
        this.clearAutoReviewOfferTimer()
        this.autoCaptureReviewPromptNonce += 1
      }
      this.bumpAutoCaptureStopTimer()
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

    const profile = this.startProfilerMark('captureWorkspaceBaseline')
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
            // Auto sessions already start from the always-on idle baseline snapshot.
            // Any workspace file that is still missing here is most likely a file
            // created during the current AI burst, so keep an empty baseline and let
            // later diff passes treat it as a new-file addition.
            this.setSessionBaselineMissing(key)
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
      this.finishProfilerMark(profile, {
        workspaceFiles: workspaceFiles.length,
        baselineEntries: this.session?.baselineEntriesByUri.size ?? 0
      })
    }

  }

  async scanWorkspaceForChanges(reason = 'scan') {
    if (!this.session) {
      return
    }

    const requestedFullScan = this.shouldRunFullWorkspaceScan(reason)
    if (this.workspaceScanPromise) {
      const activeReason = this.workspaceScanReason
      const activeFullScan = this.shouldRunFullWorkspaceScan(activeReason)
      if (activeFullScan && requestedFullScan) {
        this.logProfilerSnapshot('scanWorkspaceForChanges:coalesced', {
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

    const profile = this.startProfilerMark('scanWorkspaceForChanges', { reason })
    const scanSession = this.session
    const dirtyUrisAtScanStart = new Set(this.dirtyWorkspaceUris)
    const workspaceFiles = await this.listTrackableWorkspaceFiles()
    const currentWorkspaceUris = new Map(workspaceFiles.map((uri) => [uri.toString(), uri]))
    const shouldRunFullScan = this.shouldRunFullWorkspaceScan(reason)
    const candidateUris = this.buildWorkspaceScanCandidates(currentWorkspaceUris, shouldRunFullScan)

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

      this.finishProfilerMark(profile, {
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

  async openBlock(item) {
    const block = this.findBlockItem(item)
    if (!block) {
      return
    }

    const document = await vscode.workspace.openTextDocument(block.uri)
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    const range = getRangeForBlock(document, block.block)
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
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.acceptBlock(item)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem)
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
    const applied = await this.applyTextToUri(block.uri, nextText)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject block.')
      return
    }

    await this.refreshChangedReviewFile(block.uri)
    await this.refreshReviewPanel()

    if (currentText === nextText) {
      void vscode.window.showInformationMessage('Reject did not change the file. The block may already match the baseline.')
    }
  }

  async rejectBlockAndAdvance(item) {
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.rejectBlock(item)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem)
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
    const applied = await this.applyTextToUri(file.uri, baselineText)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject file.')
      return
    }

    await this.refreshChangedReviewFile(file.uri)
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
      const applied = await this.applyTextToUri(file.uri, baselineText)
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
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.acceptBlock(activeItem)
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }

        if (message.type === 'reject') {
          const activeItem = this.reviewPanelState.currentItem
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.rejectBlock(activeItem)
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

    const profile = this.startProfilerMark('refreshReviewPanel')
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
      this.finishProfilerMark(profile, {
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

    const document = await vscode.workspace.openTextDocument(block.uri)
    const sourceViewColumn = this.reviewPanelState?.sourceViewColumn ?? this.getPreferredSourceViewColumn()
    let editor = vscode.window.visibleTextEditors.find((candidate) => (
      candidate.document.uri.toString() === block.uri.toString() &&
      candidate.viewColumn === sourceViewColumn
    ))

    if (!editor) {
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: sourceViewColumn,
        preview: false,
        preserveFocus: options.preserveFocus ?? true
      })
    }

    const range = getRangeForBlock(document, block.block)
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
      this.statusBarItem.text = '$(pulse) Code Block Review: Auto Armed'
      this.statusBarItem.command = 'codexReview.startSession'
      this.statusBarItem.tooltip = 'Automatic capture is continuously monitoring for short bursts of large or bulk edits.'
      this.statusBarItem.show()
      return
    }

    this.statusBarItem.text = '$(sparkle) Code Block Review: Start'
    this.statusBarItem.command = 'codexReview.startSession'
    this.statusBarItem.tooltip = 'Start a review capture session'
    this.statusBarItem.show()
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
      editor.setDecorations(this.pendingDeletedDecoration, [])
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
    const pendingAddedOptions = []
    const pendingDeletedOptions = []
    const pendingModifiedOptions = []
    const currentReviewOptions = []
    const acceptedOptions = []

    if (this.session) {
      const file = this.session.reviewFiles.get(editor.document.uri.toString())
      if (file) {
        for (const block of file.blocks) {
          const range = getRangeForBlock(editor.document, block)
          if (!range) {
            continue
          }

          if (block.status === 'accepted') {
            acceptedOptions.push(createDecorationOption(range, file.label, block, 'accepted'))
          } else if (block.status === 'pending') {
            if (block.changeKind === 'addition') {
              pendingAddedOptions.push(createDecorationOption(range, file.label, block, 'pending'))
            } else if (block.changeKind === 'deletion') {
              pendingDeletedOptions.push(createDecorationOption(range, file.label, block, 'pending'))
            } else {
              pendingModifiedOptions.push(createDecorationOption(range, file.label, block, 'pending'))
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
    editor.setDecorations(this.pendingDeletedDecoration, pendingDeletedOptions)
    editor.setDecorations(this.pendingModifiedDecoration, pendingModifiedOptions)
    editor.setDecorations(this.currentReviewDecoration, currentReviewOptions)
    editor.setDecorations(this.acceptedDecoration, acceptedOptions)
  }
}

module.exports = {
  activate,
  deactivate
}
