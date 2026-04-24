const vscode = require('vscode')

function createReviewDecorations() {
  return {
    pendingAdded: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(45, 211, 111, 0.12)',
      borderColor: 'rgba(45, 211, 111, 0.80)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(45, 211, 111, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    }),
    pendingDeleted: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(239, 68, 68, 0.12)',
      borderColor: 'rgba(239, 68, 68, 0.82)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(239, 68, 68, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    }),
    pendingModified: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(34, 197, 94, 0.10)',
      borderColor: 'rgba(34, 197, 94, 0.82)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(34, 197, 94, 0.90)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    }),
    currentReview: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(250, 204, 21, 0.18)',
      borderColor: 'rgba(250, 204, 21, 0.95)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 4px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(250, 204, 21, 0.95)',
      overviewRulerLane: vscode.OverviewRulerLane.Center
    }),
    accepted: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(94, 234, 212, 0.08)',
      borderColor: 'rgba(94, 234, 212, 0.40)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(94, 234, 212, 0.55)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })
  }
}

module.exports = {
  createReviewDecorations
}
