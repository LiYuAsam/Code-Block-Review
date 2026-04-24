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
    pendingDeletedBaseline: vscode.window.createTextEditorDecorationType({}),
    deletedFilePreview: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(127, 29, 29, 0.18)',
      borderColor: 'rgba(248, 113, 113, 0.72)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 3px',
      overviewRulerColor: 'rgba(248, 113, 113, 0.85)',
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
      backgroundColor: 'rgba(245, 158, 11, 0.30)',
      borderColor: 'rgba(251, 191, 36, 1)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 5px',
      borderRadius: '4px',
      overviewRulerColor: 'rgba(251, 191, 36, 1)',
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
