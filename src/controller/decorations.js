const vscode = require('vscode')

const {
  createDecorationOption,
  createDeletedBaselineDecorationOption,
  getRangeForBlock
} = require('../ui/review-panel-ui')
const { t } = require('../utils/i18n')
const { DELETED_FILE_PREVIEW_SCHEME } = require('./deleted-preview')

const decorationControllerMethods = {
  // Clears all review decorations from currently visible editors.
  clearDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.pendingAddedDecoration, [])
      editor.setDecorations(this.pendingDeletedBaselineDecoration, [])
      editor.setDecorations(this.deletedFilePreviewDecoration, [])
      editor.setDecorations(this.pendingModifiedDecoration, [])
      editor.setDecorations(this.currentReviewDecoration, [])
      editor.setDecorations(this.acceptedDecoration, [])
    }
  },

  // Coalesces visible-editor decoration refreshes onto the next short timer tick.
  refreshAllVisibleEditors() {
    if (this.visibleEditorsRefreshTimer) {
      return
    }

    this.visibleEditorsRefreshTimer = setTimeout(() => {
      this.visibleEditorsRefreshTimer = null
      this.flushVisibleEditorsRefresh()
    }, 16)
  },

  // Applies the pending visible-editor refresh once session state is stable.
  flushVisibleEditorsRefresh() {
    if (this.state !== 'reviewing' || !this.session) {
      this.clearDecorations()
      return
    }

    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  },

  refreshDecorationsForUri(uriString) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uriString) {
        this.refreshEditor(editor)
      }
    }
  },

  // Recomputes all decoration buckets for a single live source editor.
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
              hoverMessage: new vscode.MarkdownString(t('decorations.currentReviewTooltip'))
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
  },

  // Marks every line in a virtual deleted-file preview as deleted baseline content.
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
  decorationControllerMethods
}
