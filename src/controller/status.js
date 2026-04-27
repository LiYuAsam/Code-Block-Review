const vscode = require('vscode')

const statusControllerMethods = {
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
  },

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
  },

  getAutoCaptureBaselineStatusTooltip() {
    if (this.autoCaptureBaselineStatusMessage) {
      return this.autoCaptureBaselineStatusMessage
    }

    if (this.autoCaptureBaselineEntriesByUri.size > 0) {
      return `Auto-capture baseline is ready with ${this.autoCaptureBaselineEntriesByUri.size} files.`
    }

    return 'Auto-capture baseline has not finished syncing yet.'
  },

  async syncContexts() {
    await vscode.commands.executeCommand('setContext', 'codexReview.isCapturing', this.state === 'capturing')
    await vscode.commands.executeCommand('setContext', 'codexReview.isReviewing', this.state === 'reviewing')
    await vscode.commands.executeCommand('setContext', 'codexReview.hasSession', this.state !== 'idle')
    await vscode.commands.executeCommand('setContext', 'codexReview.isAutoArmed', this.autoCaptureSettings.enabled && this.autoCaptureState === 'armed')
  }
}

module.exports = {
  statusControllerMethods
}
