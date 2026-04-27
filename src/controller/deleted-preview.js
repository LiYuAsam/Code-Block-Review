const vscode = require('vscode')

const { uriExists } = require('../review-model')
const { getRangeForBlock } = require('../ui/review-panel-ui')
const { t } = require('../utils/i18n')

const DELETED_FILE_PREVIEW_SCHEME = 'codex-review-deleted'

const deletedPreviewControllerMethods = {
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
  },

  async shouldUseDeletedFilePreview(blockInfo) {
    return Boolean(
      blockInfo?.block?.changeKind === 'deletion' &&
      blockInfo.uri?.scheme === 'file' &&
      !(await uriExists(blockInfo.uri))
    )
  },

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
  },

  provideDeletedFilePreviewContent(uri) {
    const blockInfo = this.findDeletedFilePreviewBlock(uri)
    if (!blockInfo) {
      return t('deletedPreview.unavailable')
    }

    return blockInfo.block.originalText || ''
  },

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
  },

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
  },

  async getDeletedFilePreviewUriForItem(item) {
    const block = this.findBlockItem(item)
    if (!block || !(await this.shouldUseDeletedFilePreview(block))) {
      return null
    }

    return this.createDeletedFilePreviewUri(block)
  },

  getVisibleEditorViewColumn(uri) {
    if (!uri) {
      return undefined
    }

    const uriString = uri.toString()
    return vscode.window.visibleTextEditors.find((editor) => (
      editor.document.uri.toString() === uriString
    ))?.viewColumn
  },

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
}

module.exports = {
  DELETED_FILE_PREVIEW_SCHEME,
  deletedPreviewControllerMethods
}
