const vscode = require('vscode')

const MAX_TRACKED_FILE_BYTES = 1024 * 1024
const WORKSPACE_INCLUDE_GLOB = '**/*'
const WORKSPACE_EXCLUDE_GLOB = '**/{.git,node_modules,dist,build,out,.next,.turbo,.cache,coverage}/**'
const AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS = 'windowFocus'
const AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE = 'activeEditorChange'
const SUPPORTED_AUTO_CAPTURE_TRIGGERS = new Set([
  AUTO_CAPTURE_TRIGGER_WINDOW_FOCUS,
  AUTO_CAPTURE_TRIGGER_ACTIVE_EDITOR_CHANGE
])

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
    this.autoCaptureIdleBaselineByUri = new Map()
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureReviewPending = false
    this.autoCaptureReviewPromptNonce = 0
    this.autoCaptureSettings = getAutoCaptureSettings()

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
      vscode.commands.registerCommand('codexReview.acceptFile', (item) => this.acceptFile(item)),
      vscode.commands.registerCommand('codexReview.rejectFile', (item) => this.rejectFile(item))
    )

    this.syncContexts()
    void this.ensureAutoCaptureReady({ refreshBaseline: true, silent: true })
    this.updateStatusBar()
  }

  dispose() {
    this.clearAutoCaptureTimers()
    this.disposeReviewPanel()
    this.clearDecorations()
  }

  async handleConfigurationChange(event) {
    if (!event.affectsConfiguration('codexReview')) {
      return
    }

    this.autoCaptureSettings = getAutoCaptureSettings()

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

  async refreshAutoCaptureBaseline() {
    if (this.autoCaptureBaselineRefreshPromise) {
      return this.autoCaptureBaselineRefreshPromise
    }

    this.autoCaptureBaselineRefreshPromise = (async () => {
      const snapshot = new Map()

      for (const document of vscode.workspace.textDocuments) {
        if (isTrackableDocument(document)) {
          snapshot.set(document.uri.toString(), document.getText())
        }
      }

      const workspaceFiles = filterTrackableUris(
        await vscode.workspace.findFiles(WORKSPACE_INCLUDE_GLOB, WORKSPACE_EXCLUDE_GLOB)
      )
      for (const uri of workspaceFiles) {
        const key = uri.toString()
        if (snapshot.has(key)) {
          continue
        }

        const text = await readTrackedTextFromUri(uri)
        if (text !== null) {
          snapshot.set(key, text)
        }
      }

      this.autoCaptureIdleBaselineByUri = snapshot
    })().finally(() => {
      this.autoCaptureBaselineRefreshPromise = null
    })

    return this.autoCaptureBaselineRefreshPromise
  }

  resetAutoCaptureArmedState() {
    this.clearAutoReviewOfferTimer()
    this.clearAutoObservationTimer()
    this.autoCaptureState = 'idle'
    this.autoCaptureIdleBaselineByUri = new Map()
    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
    this.autoCaptureReviewPending = false
    this.autoCaptureReviewPromptNonce += 1
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

    const shouldRefreshBaseline = refreshBaseline || this.autoCaptureIdleBaselineByUri.size === 0
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
        void this.enterReadyReview()
        return
      }

      if (selection === 'Skip') {
        void this.completeReview(null, { silent: true })
      }
    })
  }

  recordAutoCaptureEvidence(event) {
    const uriString = event.document.uri.toString()
    if (!this.autoCaptureCandidateBaselineByUri.has(uriString)) {
      this.autoCaptureCandidateBaselineByUri.set(
        uriString,
        this.autoCaptureIdleBaselineByUri.get(uriString) ?? ''
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
    let totalChangedLines = 0
    let totalChangedChars = 0
    let hasLargeChange = false

    for (const entry of this.autoCaptureEvidence) {
      uniqueUris.add(entry.uri)
      totalChangedLines += entry.changedLines
      totalChangedChars += entry.changedChars

      if (
        entry.changedLines >= thresholds.largeChangeLines ||
        entry.changedChars >= thresholds.largeChangeChars
      ) {
        hasLargeChange = true
      }
    }

    return {
      eventCount: this.autoCaptureEvidence.length,
      uniqueFileCount: uniqueUris.size,
      totalChangedLines,
      totalChangedChars,
      hasLargeChange
    }
  }

  shouldStartAutoCaptureFromEvidence() {
    const summary = this.getAutoCaptureEvidenceSummary()
    const thresholds = this.autoCaptureSettings.thresholds

    if (summary.hasLargeChange) {
      return true
    }

    if (
      summary.uniqueFileCount >= thresholds.multiFileMinFiles &&
      summary.totalChangedLines >= thresholds.multiFileMinLines
    ) {
      return true
    }

    if (
      summary.eventCount >= thresholds.burstMinEvents &&
      summary.totalChangedLines >= thresholds.burstMinLines
    ) {
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
        this.autoCaptureIdleBaselineByUri.delete(uriString)
        continue
      }

      this.autoCaptureIdleBaselineByUri.set(uriString, currentText)
    }

    this.autoCaptureCandidateBaselineByUri = new Map()
    this.autoCaptureEvidence = []
  }

  async absorbCurrentDocumentIntoAutoBaseline(document) {
    if (!document || !isTrackableDocument(document)) {
      return
    }

    const uriString = document.uri.toString()
    this.autoCaptureIdleBaselineByUri.set(uriString, document.getText())
    this.autoCaptureCandidateBaselineByUri.delete(uriString)
  }

  dropAutoCaptureEvidenceForUri(uriString) {
    if (!uriString) {
      return
    }

    this.autoCaptureEvidence = this.autoCaptureEvidence.filter((entry) => entry.uri !== uriString)
    this.autoCaptureCandidateBaselineByUri.delete(uriString)
    if (this.autoCaptureEvidence.length === 0) {
      this.clearAutoObservationTimer()
    }
  }

  async startAutoCaptureFromEvidence() {
    if (this.state !== 'idle' || this.autoCaptureState !== 'armed') {
      return false
    }

    const baselineOverrides = new Map(this.autoCaptureIdleBaselineByUri)
    for (const [uriString, text] of this.autoCaptureCandidateBaselineByUri.entries()) {
      baselineOverrides.set(uriString, text)
    }
    const observedEvidence = [...this.autoCaptureEvidence]
    const started = await this.startSession({
      mode: 'auto',
      silent: true,
      baselineOverrides
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

    const workspaceFiles = filterTrackableUris(
      await vscode.workspace.findFiles(WORKSPACE_INCLUDE_GLOB, WORKSPACE_EXCLUDE_GLOB)
    )
    const currentWorkspaceUris = new Map(workspaceFiles.map((uri) => [uri.toString(), uri]))
    const candidateUris = new Map(currentWorkspaceUris)

    for (const document of vscode.workspace.textDocuments) {
      if (isTrackableDocument(document)) {
        candidateUris.set(document.uri.toString(), document.uri)
      }
    }

    for (const uriString of this.session.baselineByUri.keys()) {
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
      const hadBaseline = this.session.baselineByUri.has(uriString)

      if (!hadBaseline && currentText === null) {
        continue
      }

      const baselineText = this.session.baselineByUri.get(uriString) ?? ''
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

    this.recordAutoCaptureEvidence(event)

    if (this.shouldStartAutoCaptureFromEvidence()) {
      return this.startAutoCaptureFromEvidence()
    }

    this.scheduleAutoCaptureObservationTimeout()
    return false
  }

  async startSession(options = {}) {
    const {
      mode = 'manual',
      silent = false,
      baselineOverrides = null
    } = options

    if (this.state !== 'idle') {
      if (!silent) {
        void vscode.window.showInformationMessage('A review session is already active.')
      }
      return false
    }

    this.clearAutoStopTimer()
    this.clearAutoReviewOfferTimer()
    this.resetAutoCaptureArmedState()
    this.sessionMode = mode
    this.session = {
      startedAt: new Date().toISOString(),
      baselineByUri: new Map(),
      touchedUris: new Set(),
      reviewFiles: new Map()
    }

    if (baselineOverrides instanceof Map) {
      for (const [key, text] of baselineOverrides.entries()) {
        this.session.baselineByUri.set(key, text)
      }
    }

    for (const document of vscode.workspace.textDocuments) {
      if (!isTrackableDocument(document)) {
        continue
      }

      const key = document.uri.toString()
      if (mode === 'manual') {
        this.session.baselineByUri.set(key, document.getText())
      } else if (!this.session.baselineByUri.has(key)) {
        this.session.baselineByUri.set(key, '')
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
  }

  async stopSession(options = {}) {
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

    this.clearAutoStopTimer()
    this.clearAutoReviewOfferTimer()
    this.autoCaptureReviewPending = false
    this.state = 'reviewing'
    await this.runFinalWorkspaceDiffPass()
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
    await this.scanWorkspaceForChanges('final-pass-1')

    // Give late-arriving file writes and workspace indexing a brief chance to settle,
    // then diff the full workspace again so newly created files are less likely to be missed.
    await sleep(300)
    await this.scanWorkspaceForChanges('final-pass-2')
  }

  async completeReview(message, options = {}) {
    const { silent = false } = options

    if (this.state === 'idle') {
      return
    }

    this.clearAutoStopTimer()
    this.clearAutoReviewOfferTimer()
    this.state = 'idle'
    this.session = null
    this.sessionMode = null
    this.resetAutoCaptureArmedState()
    this.disposeReviewPanel()
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
  }

  async refreshReview() {
    if (!this.session) {
      return
    }

    await this.scanWorkspaceForChanges()
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshAllVisibleEditors()
    await this.maybeAutoComplete()
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
    if (this.session.baselineByUri.has(key)) {
      return
    }

    // If a trackable document was not present in the session baseline snapshot,
    // treat it as created during the session so additions diff against empty content.
    this.session.baselineByUri.set(key, '')
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

    const baselineText = this.session.baselineByUri.get(uriString) ?? ''
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
      return
    }

    this.session.reviewFiles.set(uriString, {
      uri,
      label: toWorkspaceLabel(uri),
      blocks
    })
  }

  async captureWorkspaceBaseline() {
    if (!this.session) {
      return
    }

    const workspaceFiles = filterTrackableUris(
      await vscode.workspace.findFiles(WORKSPACE_INCLUDE_GLOB, WORKSPACE_EXCLUDE_GLOB)
    )

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Code Block Review: Capturing workspace baseline',
      cancellable: false
    }, async (progress) => {
      const total = workspaceFiles.length || 1
      let processed = 0

      for (const uri of workspaceFiles) {
        const key = uri.toString()
        if (!this.session || this.session.baselineByUri.has(key)) {
          processed += 1
          continue
        }

        if (this.sessionMode === 'auto') {
          // Auto sessions already start from the always-on idle baseline snapshot.
          // Any workspace file that is still missing here is most likely a file
          // created during the current AI burst, so keep an empty baseline and let
          // later diff passes treat it as a new-file addition.
          this.session.baselineByUri.set(key, '')
        } else {
          const text = await readTrackedTextFromUri(uri)
          if (text !== null) {
            this.session.baselineByUri.set(key, text)
          }
        }

        processed += 1
        if (processed % 50 === 0 || processed === total) {
          progress.report({ increment: (processed / total) * 100 })
        }
      }
    })

  }

  async scanWorkspaceForChanges(reason = 'scan') {
    if (!this.session) {
      return
    }

    const workspaceFiles = filterTrackableUris(
      await vscode.workspace.findFiles(WORKSPACE_INCLUDE_GLOB, WORKSPACE_EXCLUDE_GLOB)
    )
    const currentWorkspaceUris = new Map(workspaceFiles.map((uri) => [uri.toString(), uri]))
    const candidateUris = new Map(currentWorkspaceUris)

    for (const document of vscode.workspace.textDocuments) {
      if (isTrackableDocument(document)) {
        candidateUris.set(document.uri.toString(), document.uri)
      }
    }

    for (const uriString of this.session.baselineByUri.keys()) {
      const uri = vscode.Uri.parse(uriString)
      if (!isTrackableUri(uri)) {
        continue
      }

      if (!candidateUris.has(uriString)) {
        candidateUris.set(uriString, uri)
      }
    }

    this.session.touchedUris.clear()

    for (const [uriString, uri] of candidateUris) {
      const previousFile = this.session.reviewFiles.get(uriString)
      const previousStatusById = new Map()

      if (previousFile) {
        for (const block of previousFile.blocks) {
          previousStatusById.set(block.id, block.status)
        }
      }

      const existsInWorkspace = uri.scheme !== 'file' || currentWorkspaceUris.has(uriString)
      const currentText = await getCurrentTrackedText(uri, existsInWorkspace)
      const hadBaseline = this.session.baselineByUri.has(uriString)

      if (!hadBaseline && currentText === null) {
        this.session.reviewFiles.delete(uriString)
        continue
      }

      if (!hadBaseline) {
        this.session.baselineByUri.set(uriString, '')
      }

      const baselineText = this.session.baselineByUri.get(uriString) ?? ''
      const comparableCurrentText = currentText ?? ''

      if (baselineText === comparableCurrentText) {
        this.session.reviewFiles.delete(uriString)
        continue
      }

      this.session.touchedUris.add(uriString)
      this.updateReviewFile(uriString, uri, baselineText, comparableCurrentText, previousStatusById)
    }

  }

  getFiles() {
    if (!this.session) {
      return []
    }

    return [...this.session.reviewFiles.values()].sort((left, right) => left.label.localeCompare(right.label))
  }

  getPendingBlockCount() {
    if (!this.session) {
      return 0
    }

    let count = 0
    for (const file of this.session.reviewFiles.values()) {
      for (const block of file.blocks) {
        if (block.status === 'pending') {
          count += 1
        }
      }
    }
    return count
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

  async acceptBlock(item) {
    const block = this.findBlockItem(item)
    if (!block || block.block.status !== 'pending') {
      return
    }

    block.block.status = 'accepted'
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(block.uri.toString())
    await this.saveReviewDocument(block.uri)
    await this.refreshReviewPanel()
    await this.maybeAutoComplete()
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

    const document = await vscode.workspace.openTextDocument(block.uri)
    const nextText = rejectBlockFromDocumentText(document.getText(), block.block)
    const currentText = document.getText()

    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, fullDocumentRange(document), nextText)
    const applied = await vscode.workspace.applyEdit(edit)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject block.')
      return
    }

    await this.saveReviewDocument(document.uri)
    await this.refreshReview()
    await this.refreshReviewPanel()

    if (currentText === nextText) {
      void vscode.window.showInformationMessage('Reject did not change the file. The block may already match the baseline.')
    }
  }

  async acceptFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const document = await vscode.workspace.openTextDocument(file.uri)
    const uriString = file.uri.toString()
    this.session.baselineByUri.set(uriString, document.getText())
    this.session.reviewFiles.delete(uriString)
    this.session.touchedUris.delete(uriString)

    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(uriString)
    await this.saveReviewDocument(file.uri)
    await this.maybeAutoComplete()
  }

  async rejectFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const baselineText = this.session.baselineByUri.get(file.uri.toString()) ?? ''
    const document = await vscode.workspace.openTextDocument(file.uri)
    const fullRange = fullDocumentRange(document)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, fullRange, baselineText)
    const applied = await vscode.workspace.applyEdit(edit)

    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject file.')
      return
    }

    await this.saveReviewDocument(document.uri)
    await this.refreshReview()
    await this.refreshReviewPanel()
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

    const edit = new vscode.WorkspaceEdit()
    const targets = []

    for (const file of this.session.reviewFiles.values()) {
      const document = await vscode.workspace.openTextDocument(file.uri)
      const baselineText = this.session.baselineByUri.get(file.uri.toString()) ?? ''
      edit.replace(document.uri, fullDocumentRange(document), baselineText)
      targets.push(document.uri)
    }

    const applied = await vscode.workspace.applyEdit(edit)
    if (!applied) {
      void vscode.window.showWarningMessage('Failed to reject all review files.')
      return
    }

    for (const uri of targets) {
      await this.saveReviewDocument(uri)
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
            await this.revealReviewBlock(previousItem)
            await this.refreshReviewPanel()
          }
          return
        }

        if (message.type === 'next') {
          const nextItem = this.getAdjacentPendingBlockItem(this.reviewPanelState.currentItem, 1)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
            await this.revealReviewBlock(nextItem)
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
            await this.revealReviewBlock(nextItem)
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
            await this.revealReviewBlock(nextItem)
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
            await this.revealReviewBlock(nextItem)
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
            await this.revealReviewBlock(nextItem)
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
    this.reviewPanelState.panel.reveal(vscode.ViewColumn.Beside, true)
    await this.revealReviewBlock(item)
    await this.refreshReviewPanel()
  }

  async refreshReviewPanel() {
    if (!this.reviewPanelState) {
      return
    }

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

    if (!previewData) {
      this.reviewPanelState.panel.webview.html = createReviewPanelUnavailableHtml()
      return
    }

    if (!currentBlock && navigation.total > 0) {
      const fallbackItem = this.getOrderedPendingBlockItems()[0]
      if (fallbackItem) {
        this.reviewPanelState.currentItem = fallbackItem
        await this.revealReviewBlock(fallbackItem)
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

    return items
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

class ReviewTreeProvider {
  constructor(controller) {
    this.controller = controller
    this._onDidChangeTreeData = new vscode.EventEmitter()
    this.onDidChangeTreeData = this._onDidChangeTreeData.event
  }

  refresh() {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element) {
    return element
  }

  getChildren(element) {
    if (!this.controller.session) {
      if (this.controller.autoCaptureSettings.enabled && this.controller.autoCaptureState === 'armed') {
        return [
          new MessageItem('Auto Armed: continuously monitoring for short bursts of large or bulk edits.')
        ]
      }

      return [
        new MessageItem('No active review session. Run "Code Block Review: Start Review Session".')
      ]
    }

    if (element instanceof FileItem) {
      return element.file.blocks.map((block) => new BlockItem(element.file, block))
    }

    const files = this.controller.getFiles()
    if (files.length === 0) {
      const message = this.controller.state === 'capturing'
        ? (this.controller.sessionMode === 'auto' && this.controller.autoCaptureReviewPending
            ? 'Automatic capture is ready. Click the status bar or run "Stop Capture And Review" to open review.'
            : 'Capture is active. Edit some files, then stop capture to review.')
        : 'No review blocks found yet.'
      return [new MessageItem(message)]
    }

    return files.map((file) => new FileItem(file))
  }
}

class ReviewBlockCodeLensProvider {
  constructor(controller) {
    this.controller = controller
    this._onDidChangeCodeLenses = new vscode.EventEmitter()
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event
  }

  refresh() {
    this._onDidChangeCodeLenses.fire()
  }

  provideCodeLenses(document) {
    if (this.controller.state !== 'reviewing' || !this.controller.session) {
      return []
    }

    const file = this.controller.session.reviewFiles.get(document.uri.toString())
    if (!file) {
      return []
    }

    const codeLenses = []
    for (const block of file.blocks) {
      if (block.status !== 'pending') {
        continue
      }

      const range = getBottomActionCodeLensRange(document, block)
      if (!range) {
        continue
      }

      const args = [createReviewItem(file.uri, block)]

      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.previewBlock',
        title: `$(open-preview) Open Review Panel: ${formatActionTitleSuffix(block)}`,
        arguments: args,
        tooltip: 'Open the dedicated review panel for this block'
      }))

      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.acceptBlock',
        title: `$(check) KEEP THIS ${formatActionTitleSuffix(block)}`,
        arguments: args,
        tooltip: 'Accept this review block'
      }))

      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.rejectBlock',
        title: `$(close) REJECT THIS ${formatActionTitleSuffix(block)}`,
        arguments: args,
        tooltip: 'Reject this review block'
      }))
    }

    return codeLenses
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(label) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'message'
  }
}

class FileItem extends vscode.TreeItem {
  constructor(file) {
    const pendingCount = file.blocks.filter((block) => block.status === 'pending').length
    const acceptedCount = file.blocks.filter((block) => block.status === 'accepted').length
    const description = pendingCount > 0 ? `${pendingCount} pending` : `${acceptedCount} accepted`

    super(file.label, vscode.TreeItemCollapsibleState.Expanded)
    this.file = file
    this.kind = 'file'
    this.uri = file.uri
    this.description = description
    this.contextValue = 'file'
    this.iconPath = new vscode.ThemeIcon(pendingCount > 0 ? 'diff-multiple' : 'pass')
    this.command = {
      command: 'codexReview.openReviewPanel',
      title: 'Open Review Panel',
      arguments: [this]
    }
  }
}

class BlockItem extends vscode.TreeItem {
  constructor(file, block) {
    const lineLabel = formatBlockLabel(block)
    super(lineLabel, vscode.TreeItemCollapsibleState.None)
    this.kind = 'block'
    this.uri = file.uri
    this.blockId = block.id
    this.description = block.status
    this.tooltip = createBlockTooltip(file.label, block)
    this.contextValue = 'block'
    this.iconPath = new vscode.ThemeIcon(block.status === 'accepted' ? 'pass' : 'diff')
    this.command = {
      command: 'codexReview.openBlock',
      title: 'Open Review Block',
      arguments: [this]
    }
  }
}

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

  const patterns = getIgnoredReviewGlobs()
  if (patterns.length === 0) {
    return false
  }

  const relativePath = normalizeGlobPath(vscode.workspace.asRelativePath(uri, false))
  const baseName = relativePath.split('/').pop() ?? relativePath

  return patterns.some((pattern) => {
    if (!pattern) {
      return false
    }

    if (globMatches(baseName, pattern)) {
      return true
    }

    return globMatches(relativePath, pattern)
  })
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

function normalizeGlobPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function globMatches(value, pattern) {
  const normalizedValue = normalizeGlobPath(value)
  const normalizedPattern = normalizeGlobPath(pattern)
  if (!normalizedValue || !normalizedPattern) {
    return false
  }

  const patternsToTry = normalizedPattern.startsWith('**/')
    ? [normalizedPattern, normalizedPattern.slice(3)]
    : [normalizedPattern]

  return patternsToTry.some((candidate) => {
    if (!candidate) {
      return false
    }

    const source = candidate
      .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLE_STAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLE_STAR::/g, '.*')

    return new RegExp(`^${source}$`).test(normalizedValue)
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
    captureIdleMs: clampNumber(config.get('captureIdleSeconds', 4), 1, 600) * 1000,
    reviewOfferMs: clampNumber(config.get('reviewOfferSeconds', 60), 1, 600) * 1000,
    observationWindowMs: clampNumber(config.get('observationWindowSeconds', 2), 0.1, 60) * 1000,
    thresholds: {
      largeChangeLines: clampNumber(config.get('largeChangeLines', 8), 1, 10000),
      largeChangeChars: clampNumber(config.get('largeChangeChars', 120), 1, 1000000),
      multiFileMinFiles: clampNumber(config.get('multiFileMinFiles', 2), 1, 1000),
      multiFileMinLines: clampNumber(config.get('multiFileMinLines', 4), 1, 100000),
      burstMinEvents: clampNumber(config.get('burstMinEvents', 3), 1, 10000),
      burstMinLines: clampNumber(config.get('burstMinLines', 10), 1, 100000)
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

  for (const change of event.contentChanges) {
    const insertedLines = countInsertedLines(change.text)
    const removedLines = countRemovedLines(change)
    const touchedLines = Math.max(insertedLines, removedLines, (change.text.length > 0 || change.rangeLength > 0) ? 1 : 0)

    changedLines += touchedLines
    changedChars += change.text.length + change.rangeLength
  }

  return {
    changedLines,
    changedChars
  }
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

function createBlockTooltip(fileLabel, block) {
  const lines = [
    fileLabel,
    formatBlockLabel(block),
    `Type: ${block.changeKind}`,
    '',
    'Current',
    block.modifiedText || '(empty)',
    '',
    'Baseline',
    block.originalText || '(empty)'
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
      },
      after: {
        contentText: getBlockSummaryText(block, state),
        color: getSummaryColor(block, state),
        margin: '0 0 0 12px',
        fontStyle: 'italic'
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
    markdown.appendCodeblock(block.modifiedText, '')
  }

  if (block.originalText) {
    markdown.appendMarkdown('\n\n**Baseline**\n')
    markdown.appendCodeblock(block.originalText, '')
  }

  return markdown
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

function getBlockSummaryText(block, state) {
  if (state === 'accepted') {
    return 'reviewed'
  }

  if (block.changeKind === 'addition') {
    return `${Math.max(block.modifiedLines.length, 1)} line${block.modifiedLines.length === 1 ? '' : 's'} added`
  }

  if (block.changeKind === 'deletion') {
    return `${Math.max(block.originalLines.length, 1)} line${block.originalLines.length === 1 ? '' : 's'} deleted`
  }

  const oldCount = Math.max(block.originalLines.length, 1)
  const newCount = Math.max(block.modifiedLines.length, 1)
  return `${oldCount} old -> ${newCount} new`
}

function getSummaryColor(block, state) {
  if (state === 'accepted') {
    return 'rgba(153, 246, 228, 0.80)'
  }

  if (block.changeKind === 'addition') {
    return 'rgba(187, 247, 208, 0.85)'
  }

  if (block.changeKind === 'deletion') {
    return 'rgba(254, 202, 202, 0.85)'
  }

  return 'rgba(187, 247, 208, 0.85)'
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

function formatActionTitleSuffix(block) {
  if (block.changeKind === 'addition') {
    return 'ADDED CHANGE'
  }

  if (block.changeKind === 'deletion') {
    return 'DELETED CHANGE'
  }

  return 'REPLACEMENT CHANGE'
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

module.exports = {
  activate,
  deactivate
}
