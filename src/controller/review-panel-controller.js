const vscode = require('vscode')

const {
  createReviewItem,
  formatBlockLabel,
  getReviewBlockKey,
  getReviewItemKey
} = require('../review-model')
const {
  cloneBlockForPreview,
  createReviewPanelHtml,
  createReviewPanelLoadingHtml,
  createReviewPanelUnavailableHtml
} = require('../ui/review-panel-ui')
const { t } = require('../utils/i18n')

const reviewPanelControllerMethods = {
  async showReviewPanel(item) {
    const block = this.findBlockItem(item)
    if (!block) {
      void vscode.window.showInformationMessage(t('message.couldNotFindBlock'))
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
          const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(activeItem)
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.acceptBlock(activeItem)
          await this.closeDeletedFilePreviewEditors(deletedPreviewUri)
          if (this.reviewPanelState && nextItem) {
            await this.safeRevealReviewBlock(nextItem)
          }
          await this.refreshReviewPanel()
          return
        }

        if (message.type === 'reject') {
          const activeItem = this.reviewPanelState.currentItem
          const deletedPreviewUri = await this.getDeletedFilePreviewUriForItem(activeItem)
          const nextItem = this.getPreferredNextReviewItem(activeItem)
          if (nextItem) {
            this.reviewPanelState.currentItem = nextItem
          }
          await this.rejectBlock(activeItem)
          await this.closeDeletedFilePreviewEditors(deletedPreviewUri)
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
  },

  async refreshReviewPanel() {
    if (!this.reviewPanelState) {
      return
    }

    const profile = this.profiler.startMark('refreshReviewPanel')
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
      this.profiler.finishMark(profile, {
        hasLiveBlock: currentBlock ? 'true' : 'false',
        navigationTotal: navigation.total
      })
    }
  },

  disposeReviewPanel() {
    if (!this.reviewPanelState) {
      return
    }

    this.reviewPanelState.panel.dispose()
    this.reviewPanelState = null
  },

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
  },

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
  },

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
  },

  getPreferredNextReviewItem(currentItem) {
    return this.getAdjacentPendingBlockItem(currentItem, 1) ?? this.getAdjacentPendingBlockItem(currentItem, -1)
  },

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
  },

  getPreferredSourceViewColumn() {
    if (vscode.window.activeTextEditor?.viewColumn) {
      return vscode.window.activeTextEditor.viewColumn
    }

    return this.reviewPanelState?.sourceViewColumn ?? vscode.ViewColumn.One
  },

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
  },

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
  },

  async revealReviewBlock(item, options = {}) {
    const block = this.findBlockItem(item)
    if (!block) {
      this.refreshAllVisibleEditors()
      return
    }

    const source = await this.openReviewSourceDocument(block)
    const document = source.document
    const sourceViewColumn = this.reviewPanelState?.sourceViewColumn ?? this.getPreferredSourceViewColumn()
    let editor = vscode.window.visibleTextEditors.find((candidate) => (
      candidate.document.uri.toString() === document.uri.toString() &&
      candidate.viewColumn === sourceViewColumn
    ))

    if (!editor) {
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: sourceViewColumn,
        preview: false,
        preserveFocus: options.preserveFocus ?? true
      })
    }

    const range = this.getSourceRangeForBlock(document, block.block, source.isDeletedFilePreview)
    if (range) {
      editor.selection = new vscode.Selection(range.start, range.start)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    }
    this.refreshAllVisibleEditors()
  },

  async safeRevealReviewBlock(item, options = {}) {
    try {
      await this.revealReviewBlock(item, options)
    } catch (error) {
      console.error('Code Block Review: failed to reveal review block', error)
    }
  }
}

module.exports = {
  reviewPanelControllerMethods
}
