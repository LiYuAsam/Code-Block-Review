const vscode = require('vscode')

const {
  createReviewItem,
  formatBlockLabel,
  getReviewItemKey
} = require('../review-model')
const {
  createBlockTooltip,
  getBottomActionCodeLensRange
} = require('./review-panel-ui')
const { t } = require('../utils/i18n')

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
    if (element instanceof FileItem) {
      const file = this.controller.session?.reviewFiles.get(element.uri.toString())
      return file ? new FileItem(file) : element
    }

    return element
  }

  getChildren(element) {
    if (!this.controller.session) {
      if (this.controller.autoCaptureSettings.enabled && this.controller.autoCaptureState === 'armed') {
        return [
          new MessageItem(t('tree.autoArmed'))
        ]
      }

      return [
        new MessageItem(t('tree.noSession'))
      ]
    }

    if (element instanceof FileItem) {
      const file = this.controller.session?.reviewFiles.get(element.uri.toString())
      return file ? file.blocks.map((block) => new BlockItem(file, block)) : []
    }

    const files = this.controller.getFiles()
    if (files.length === 0) {
      const message = this.controller.state === 'capturing'
        ? (this.controller.sessionMode === 'auto' && this.controller.autoCaptureReviewPending
            ? t('tree.autoReady')
            : t('tree.capturing'))
        : t('tree.noBlocks')
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

    let file = this.controller.session.reviewFiles.get(document.uri.toString())
    let blocks = file?.blocks ?? []
    let isDeletedFilePreview = false
    const deletedFilePreviewBlock = !file && typeof this.controller.findDeletedFilePreviewBlock === 'function'
      ? this.controller.findDeletedFilePreviewBlock(document.uri)
      : null
    if (deletedFilePreviewBlock) {
      file = this.controller.session.reviewFiles.get(deletedFilePreviewBlock.uri.toString())
      blocks = deletedFilePreviewBlock.block ? [deletedFilePreviewBlock.block] : []
      isDeletedFilePreview = true
    }

    if (!file) {
      return []
    }

    const pendingItems = this.controller.getOrderedPendingBlockItems()
    const pendingIndexByKey = new Map(
      pendingItems.map((item, index) => [getReviewItemKey(item), index])
    )
    const codeLenses = []
    for (const block of blocks) {
      if (block.status !== 'pending') {
        continue
      }

      const range = getBottomActionCodeLensRange(document, block, { isDeletedFilePreview })
      if (!range) {
        continue
      }

      const args = [createReviewItem(file.uri, block)]
      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.acceptBlockAndAdvance',
        title: `$(pass-filled) ${t('action.accept')}`,
        arguments: args,
        tooltip: t('codelens.acceptTooltip')
      }))

      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.rejectBlockAndAdvance',
        title: `$(error) ${t('action.reject')}`,
        arguments: args,
        tooltip: t('codelens.rejectTooltip')
      }))

      const itemKey = getReviewItemKey(args[0])
      const currentIndex = itemKey ? pendingIndexByKey.get(itemKey) ?? -1 : -1
      const previousItem = currentIndex > 0 ? pendingItems[currentIndex - 1] : null
      const nextItem = currentIndex >= 0 && currentIndex < pendingItems.length - 1
        ? pendingItems[currentIndex + 1]
        : null

      if (previousItem) {
        codeLenses.push(new vscode.CodeLens(range, {
          command: 'codexReview.openPreviousPendingBlock',
          title: `$(arrow-left) ${t('action.prevBlock')}`,
          arguments: args,
          tooltip: t('codelens.prevTooltip')
        }))
      }

      if (nextItem) {
        codeLenses.push(new vscode.CodeLens(range, {
          command: 'codexReview.openNextPendingBlock',
          title: `$(arrow-right) ${t('action.nextBlock')}`,
          arguments: args,
          tooltip: t('codelens.nextTooltip')
        }))
      }

      codeLenses.push(new vscode.CodeLens(range, {
        command: 'codexReview.previewBlock',
        title: `$(open-preview) ${t('action.review')}`,
        arguments: args,
        tooltip: t('codelens.reviewTooltip')
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
    const description = pendingCount > 0
      ? t('tree.pending', { count: pendingCount })
      : t('tree.accepted', { count: acceptedCount })

    super(file.label, vscode.TreeItemCollapsibleState.Expanded)
    this.file = file
    this.kind = 'file'
    this.uri = file.uri
    this.description = description
    this.contextValue = 'file'
    this.iconPath = new vscode.ThemeIcon(pendingCount > 0 ? 'diff-multiple' : 'pass')
    this.command = {
      command: 'codexReview.openReviewPanel',
      title: t('tree.openPanel'),
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
      title: t('tree.openBlock'),
      arguments: [this]
    }
  }
}

module.exports = {
  ReviewBlockCodeLensProvider,
  ReviewTreeProvider
}
