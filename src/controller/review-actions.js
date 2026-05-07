const path = require('path')
const vscode = require('vscode')

const {
  createReviewItem,
  findBestMatchingBlock,
  fullDocumentRange,
  rejectBlockFromDocumentText,
  safeOpenDocument,
  syncReviewItem,
  toWorkspaceLabel,
  uriExists
} = require('../review-model')
const { t } = require('../utils/i18n')

const reviewActionControllerMethods = {
  // Returns cached review files in stable label order for tree rendering.
  getFiles() {
    if (!this.session) {
      return []
    }

    if (this.cachedFilesVersion !== this.reviewDataVersion) {
      this.cachedFiles = [...this.session.reviewFiles.values()].sort((left, right) => left.label.localeCompare(right.label))
      this.cachedFilesVersion = this.reviewDataVersion
    }

    return this.cachedFiles
  },

  // Counts pending blocks lazily so status bar and commands stay cheap during refreshes.
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
  },

  async openBlock(item, options = {}) {
    const block = this.findBlockItem(item)
    if (!block) {
      return
    }

    const source = await this.openReviewSourceDocument(block)
    const document = source.document
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: options.viewColumn,
      preview: false,
      preserveFocus: options.preserveFocus
    })
    const range = this.getSourceRangeForBlock(document, block.block, source.isDeletedFilePreview)
    if (range) {
      editor.selection = new vscode.Selection(range.start, range.start)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    }
    await this.safeRevealReviewTreeItem(createReviewItem(block.uri, block.block))
  },

  async openChangeKindCategory(item) {
    if (this.state !== 'reviewing' || !this.session || item?.kind !== 'changeKind' || !item.uri || !item.changeKind) {
      return false
    }

    const file = this.session.reviewFiles.get(item.uri.toString())
    if (!file) {
      return false
    }

    const blocks = file.blocks.filter((block) => block.status === 'pending' && block.changeKind === item.changeKind)
    if (blocks.length === 0) {
      return false
    }

    const key = `${file.uri.toString()}::${item.changeKind}`
    const lastBlockId = this.changeKindNavigationByKey.get(key)
    const lastIndex = blocks.findIndex((block) => block.id === lastBlockId)
    const nextIndex = lastIndex >= 0 ? (lastIndex + 1) % blocks.length : 0
    const targetBlock = blocks[nextIndex]

    this.changeKindNavigationByKey.set(key, targetBlock.id)
    const targetItem = createReviewItem(file.uri, targetBlock)
    await this.openBlock(targetItem)
    await this.syncReviewPanelToBlock(targetItem)
    return true
  },

  async openFirstPendingBlock() {
    if (this.state !== 'reviewing' || !this.session) {
      return false
    }

    const firstPendingItem = this.getOrderedPendingBlockItems()[0] ?? null
    if (!firstPendingItem) {
      void vscode.window.showInformationMessage(t('message.noPendingBlocks'))
      return false
    }

    await this.openBlock(firstPendingItem)
    return true
  },

  async openAdjacentPendingBlock(item, direction) {
    if (this.state !== 'reviewing' || !this.session) {
      return false
    }

    const targetItem = this.getAdjacentPendingBlockItem(item, direction)
    if (!targetItem) {
      return false
    }

    await this.openBlock(targetItem)
    await this.syncReviewPanelToBlock(targetItem)
    return true
  },

  // Resolves a file/block/tree item into the block that the review panel should display.
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
      void vscode.window.showInformationMessage(t('message.noPendingBlocks'))
      return
    }

    await this.showReviewPanel(targetItem)
  },

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
        void vscode.window.showWarningMessage(t('message.failedToSave', { file: toWorkspaceLabel(uri) }))
      }
      return saved
    } catch {
      void vscode.window.showWarningMessage(t('message.failedToSave', { file: toWorkspaceLabel(uri) }))
      return false
    }
  },

  // Writes replacement text through open documents when possible, falling back to workspace file writes.
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
  },

  async deleteFileUri(uri) {
    if (!uri || uri.scheme !== 'file') {
      return false
    }

    try {
      const edit = new vscode.WorkspaceEdit()
      edit.deleteFile(uri, { ignoreIfNotExists: true })
      const applied = await vscode.workspace.applyEdit(edit)
      if (applied) {
        this.invalidateWorkspaceFileListCache()
      }
      return applied
    } catch {
      return false
    }
  },

  async rejectUriToBaseline(uri, baselineText) {
    if (this.hasSessionMissingBaseline(uri.toString())) {
      return this.deleteFileUri(uri)
    }

    return this.applyTextToUri(uri, baselineText)
  },

  async finishRejectedMissingFile(uri) {
    if (!this.session || !uri) {
      return
    }

    const uriString = uri.toString()
    this.session.reviewFiles.delete(uriString)
    this.session.touchedUris.delete(uriString)
    this.dirtyWorkspaceUris.delete(uriString)
    this.markReviewDataChanged()
    this.treeProvider.refresh()
    this.blockActionProvider.refresh()
    this.updateStatusBar()
    this.refreshDecorationsForUri(uriString)
    await this.maybeAutoComplete()
  },

  // Marks a block as accepted while keeping the user's current file contents intact.
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
  },

  async acceptBlockAndAdvance(item) {
    const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(item)
    const sourceViewColumn = this.getVisibleEditorViewColumn(deletedPreviewUri)
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.acceptBlock(item)
    await this.closeDeletedFilePreviewEditors(deletedPreviewUri)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem, { viewColumn: sourceViewColumn })
    }
  },

  async previewBlock(item) {
    await this.openReviewPanel(item)
  },

  // Reverts one pending block back to baseline text and refreshes its review file.
  async rejectBlock(item) {
    const block = this.findBlockItem(item)
    if (!block) {
      void vscode.window.showWarningMessage(t('message.couldNotFindBlock'))
      return
    }

    const document = await safeOpenDocument(block.uri.toString())
    const currentText = document ? document.getText() : ''
    const nextText = rejectBlockFromDocumentText(currentText, block.block)
    const shouldDeleteFile = nextText === '' && this.hasSessionMissingBaseline(block.uri.toString())
    const applied = nextText === ''
      ? await this.rejectUriToBaseline(block.uri, nextText)
      : await this.applyTextToUri(block.uri, nextText)

    if (!applied) {
      void vscode.window.showWarningMessage(t('message.failedToRejectBlock'))
      return
    }

    if (shouldDeleteFile) {
      await this.finishRejectedMissingFile(block.uri)
    } else {
      await this.refreshChangedReviewFile(block.uri)
    }
    await this.refreshReviewPanel()

    if (currentText === nextText) {
      void vscode.window.showInformationMessage(t('message.rejectNoChange'))
    }
  },

  async rejectBlockAndAdvance(item) {
    const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(item)
    const sourceViewColumn = this.getVisibleEditorViewColumn(deletedPreviewUri)
    const nextItem = this.getPreferredNextReviewItem(item)
    await this.rejectBlock(item)
    await this.closeDeletedFilePreviewEditors(deletedPreviewUri)

    if (nextItem && this.state === 'reviewing') {
      await this.openBlock(nextItem, { viewColumn: sourceViewColumn })
    }
  },

  // Accepts all pending blocks in a file and advances that file's session baseline.
  async acceptFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const pendingBlocks = file.blocks.filter((block) => block.status === 'pending')
    if (pendingBlocks.length === 0) {
      await this.maybeAutoComplete()
      return
    }

    const uriString = file.uri.toString()
    const document = await safeOpenDocument(uriString)
    for (const block of pendingBlocks) {
      block.status = 'accepted'
    }
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
  },

  // Rejects all pending blocks in a file, deleting files that were created during the session.
  async rejectFile(item) {
    const file = this.findFileItem(item)
    if (!file || !this.session) {
      return
    }

    const result = await this.rejectPendingBlocksInFile(file)

    if (!result.applied) {
      void vscode.window.showWarningMessage(t('message.failedToRejectFile'))
      return
    }

    if (result.deleted) {
      await this.finishRejectedMissingFile(file.uri)
    } else {
      await this.refreshChangedReviewFile(file.uri)
    }
    await this.refreshReviewPanel()
  },

  // Applies pending block rejections from bottom to top so line ranges remain valid.
  async rejectPendingBlocksInFile(file) {
    if (!file || !this.session) {
      return { applied: false, deleted: false }
    }

    const pendingBlocks = file.blocks
      .filter((block) => block.status === 'pending')
      .sort((left, right) => {
        if (left.modifiedStart !== right.modifiedStart) {
          return right.modifiedStart - left.modifiedStart
        }

        return right.modifiedEnd - left.modifiedEnd
      })

    if (pendingBlocks.length === 0) {
      return { applied: true, deleted: false }
    }

    const document = await safeOpenDocument(file.uri.toString())
    let nextText = document ? document.getText() : ''
    for (const block of pendingBlocks) {
      nextText = rejectBlockFromDocumentText(nextText, block)
    }

    const deleted = nextText === '' && this.hasSessionMissingBaseline(file.uri.toString())
    const applied = nextText === ''
      ? await this.rejectUriToBaseline(file.uri, nextText)
      : await this.applyTextToUri(file.uri, nextText)

    return { applied, deleted }
  },

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
  },

  async acceptAllFiles() {
    if (!this.session || this.state !== 'reviewing') {
      return
    }

    const uris = [...this.session.reviewFiles.values()].map((file) => file.uri)
    for (const uri of uris) {
      await this.saveReviewDocument(uri)
    }

    await this.completeReview(t('message.acceptedRemaining'))
  },

  async rejectAllFiles() {
    if (!this.session || this.state !== 'reviewing') {
      return
    }

    const files = [...this.session.reviewFiles.values()]
    for (const file of files) {
      const result = await this.rejectPendingBlocksInFile(file)
      if (!result.applied) {
        void vscode.window.showWarningMessage(t('message.failedToRejectNamedFile', { file: toWorkspaceLabel(file.uri) }))
        return
      }
    }

    await this.completeReview(t('message.rejectedRemaining'))
  },

  findFileItem(item) {
    if (!this.session || !item || item.kind !== 'file') {
      return null
    }

    return this.session.reviewFiles.get(item.uri.toString()) ?? null
  },

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
  },

  async maybeAutoComplete() {
    if (this.state !== 'reviewing') {
      return
    }

    if (this.getPendingBlockCount() === 0) {
      await this.completeReview(t('message.allHandled'))
    }
  }
}

module.exports = {
  reviewActionControllerMethods
}
