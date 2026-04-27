const vscode = require('vscode')

const { isTrackableDocument, sleep } = require('../review-model')
const { createSessionBaselineSnapshotDirectory } = require('../utils/baseline-snapshots')
const { pluralKey, t } = require('../utils/i18n')

const sessionControllerMethods = {
  // Creates a manual or auto capture session and records the baseline that review diffs compare against.
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
        void vscode.window.showInformationMessage(t('message.sessionAlreadyActive'))
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
        gitStatesByRoot: new Map(),
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
      this.session.gitStatesByRoot = await this.captureSessionGitStates()

      this.state = 'capturing'
      this.autoCaptureReviewPending = false
      this.autoCaptureLargeSessionWarningShown = false
      await this.syncContexts()
      this.treeProvider.refresh()
      this.blockActionProvider.refresh()
      this.updateStatusBar()
      this.refreshAllVisibleEditors()
      if (!silent) {
        void vscode.window.showInformationMessage(t('message.captureStarted'))
      }

      return true
    } finally {
      this.profiler.finishMark(profile, {
        baselineEntries: this.session?.baselineEntriesByUri.size ?? 0,
        touchedUris: this.session?.touchedUris.size ?? 0
      })
    }
  },

  // Moves a capture session into review mode after the final workspace diff pass.
  async stopSession(options = {}) {
    const profile = this.profiler.startMark('stopSession', { requestedMode: options.requestedMode ?? '' })
    const {
      silent = false,
      requestedMode = null
    } = options

    if (this.state !== 'capturing') {
      if (!silent) {
        void vscode.window.showInformationMessage(t('message.noCaptureSession'))
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
        await this.completeReview(t('message.noBlocksSessionClosed'), { silent })
        return true
      }

      if (!silent) {
        void vscode.window.showInformationMessage(t('message.enteredReview', {
          count: pending,
          blockWord: pluralKey(pending, 'unit.block.singular', 'unit.block.plural')
        }))
      }

      return true
    } finally {
      this.profiler.finishMark(profile, {
        pendingBlocks: this.getPendingBlockCount(),
        reviewFiles: this.session?.reviewFiles.size ?? 0
      })
    }
  },

  // Opens the review UI for an auto-capture session that has already reached Ready.
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
  },

  async enterReadyReviewAndOpenFirstPendingBlock() {
    const entered = await this.enterReadyReviewWithoutPanel()
    if (!entered) {
      return false
    }

    return this.openFirstPendingBlock()
  },

  async enterReadyReviewWithoutPanel() {
    if (this.sessionMode === 'auto' && this.state === 'capturing' && this.autoCaptureReviewPending) {
      return this.stopSession({
        silent: true,
        requestedMode: 'auto'
      })
    }

    return this.state === 'reviewing'
  },

  // Marks an auto-capture session as Ready once edits settle and there is pending review work.
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
    await this.maybeWarnLargeAutoReviewSession()
    this.promptAutoReviewOffer()
    this.scheduleAutoReviewOfferTimer()
  },

  // Performs the settle-time scan used before showing review results.
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
  },

  // Closes the active session, releases snapshot files, and re-arms auto capture.
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
  },

  // Rebuilds review data from the current workspace without changing the active session.
  async refreshReview() {
    if (!this.session) {
      return
    }

    const profile = this.profiler.startMark('refreshReview')
    try {
      await this.scanWorkspaceForChanges('manual-refresh')
      if (await this.completeAutoReadySessionIfEmpty()) {
        return
      }

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
}

module.exports = {
  sessionControllerMethods
}
