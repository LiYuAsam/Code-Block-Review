const vscode = require('vscode')
const { t } = require('../utils/i18n')

const statusControllerMethods = {
  updateStatusBar() {
    if (this.state === 'capturing' && this.session) {
      if (this.sessionMode === 'auto' && this.autoCaptureReviewPending) {
        this.statusBarItem.text = t('status.ready', { count: this.getPendingBlockCount() })
        this.statusBarItem.command = 'codexReview.enterReadyReview'
        this.statusBarItem.tooltip = this.autoCaptureSettings.reviewOfferMs <= 0
          ? t('tooltip.readyIndefinite')
          : t('tooltip.readyTimed')
        this.statusBarItem.show()
        return
      }

      this.statusBarItem.text = t('status.capturing', { count: this.session.touchedUris.size })
      this.statusBarItem.command = 'codexReview.stopSession'
      this.statusBarItem.tooltip = this.sessionMode === 'auto'
        ? t('tooltip.openAutoCaptureReview')
        : t('tooltip.stopCapture')
      this.statusBarItem.show()
      return
    }

    if (this.state === 'reviewing') {
      this.statusBarItem.text = t('status.pending', { count: this.getPendingBlockCount() })
      this.statusBarItem.command = 'codexReview.openReviewPanel'
      this.statusBarItem.tooltip = t('tooltip.openReviewPanel')
      this.statusBarItem.show()
      return
    }

    if (this.autoCaptureSettings.enabled && this.autoCaptureState === 'armed') {
      this.statusBarItem.text = this.getAutoCaptureStatusBarText()
      this.statusBarItem.command = 'codexReview.startSession'
      this.statusBarItem.tooltip = [
        t('tooltip.autoMonitoring'),
        this.getAutoCaptureBaselineStatusTooltip()
      ].filter(Boolean).join('\n')
      this.statusBarItem.show()
      return
    }

    this.statusBarItem.text = t('status.start')
    this.statusBarItem.command = 'codexReview.startSession'
    this.statusBarItem.tooltip = t('tooltip.startCapture')
    this.statusBarItem.show()
  },

  getAutoCaptureStatusBarText() {
    if (this.autoCaptureBaselineRefreshPromise || this.autoCaptureBaselineStatus === 'syncing') {
      return t('status.baselineSyncing')
    }

    if (this.autoCaptureBaselineStatus === 'failed') {
      return t('status.baselineFailed')
    }

    if (this.autoCaptureBaselineEntriesByUri.size === 0) {
      return t('status.baselinePending')
    }

    return t('status.autoArmed')
  },

  getAutoCaptureBaselineStatusTooltip() {
    if (this.autoCaptureBaselineStatusMessage) {
      return this.autoCaptureBaselineStatusMessage
    }

    if (this.autoCaptureBaselineEntriesByUri.size > 0) {
      return t('tooltip.baselineReady', { count: this.autoCaptureBaselineEntriesByUri.size })
    }

    return t('tooltip.baselineNotReady')
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
