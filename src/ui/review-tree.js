const vscode = require('vscode')
const path = require('path')

const {
  createReviewItem,
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

  // Provides the Explorer tree contents for idle, capturing, ready, and reviewing states.
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

    if (element instanceof ReviewStateItem) {
      return buildReviewTree(this.controller.getFiles())
    }

    if (element instanceof FolderItem) {
      return element.children
    }

    if (element instanceof FileItem) {
      const file = this.controller.session?.reviewFiles.get(element.uri.toString())
      return file ? createChangeKindItems(file) : []
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

    const label = this.controller.state === 'capturing'
      ? t('tree.captureSession')
      : t('tree.reviewing')
    return [new ReviewStateItem(label, getPendingCount(files))]
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

  // Adds inline review actions beneath pending blocks in live or deleted-preview documents.
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

class ReviewStateItem extends vscode.TreeItem {
  constructor(label, count) {
    super(label, vscode.TreeItemCollapsibleState.Expanded)
    this.description = String(count)
    this.contextValue = 'reviewState'
    this.iconPath = new vscode.ThemeIcon('sync~spin')
    this.command = {
      command: 'codexReview.openReviewPanel',
      title: t('tree.openPanel')
    }
  }
}

class FolderItem extends vscode.TreeItem {
  constructor(label, children, count) {
    super(label, vscode.TreeItemCollapsibleState.Expanded)
    this.children = children
    this.description = String(count)
    this.contextValue = 'folder'
    this.iconPath = new vscode.ThemeIcon('folder')
  }
}

class FileItem extends vscode.TreeItem {
  constructor(file) {
    const pendingCount = file.blocks.filter((block) => block.status === 'pending').length
    const acceptedCount = file.blocks.filter((block) => block.status === 'accepted').length
    const description = String(pendingCount > 0 ? pendingCount : acceptedCount)
    const hasChildren = pendingCount > 0

    super(path.posix.basename(normalizeTreePath(file.label)), hasChildren
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None)
    this.file = file
    this.kind = 'file'
    this.uri = file.uri
    this.resourceUri = file.uri
    this.description = description
    this.contextValue = 'file'
    this.iconPath = new vscode.ThemeIcon('file')
    this.tooltip = file.label
    this.command = {
      command: 'codexReview.openReviewPanel',
      title: t('tree.openPanel'),
      arguments: [this]
    }
  }
}

class ChangeKindItem extends vscode.TreeItem {
  constructor(file, changeKind, blocks) {
    const firstBlock = blocks[0]

    super(getChangeKindLabel(changeKind), vscode.TreeItemCollapsibleState.None)
    this.kind = 'changeKind'
    this.uri = file.uri
    this.changeKind = changeKind
    this.blockId = firstBlock.id
    this.description = String(blocks.length)
    this.tooltip = createBlockTooltip(file.label, firstBlock)
    this.contextValue = 'blockCategory'
    this.iconPath = getChangeKindIcon(changeKind)
    this.command = {
      command: 'codexReview.openChangeKindCategory',
      title: t('tree.openBlock'),
      arguments: [this]
    }
  }
}

const CHANGE_KIND_ORDER = ['addition', 'modification', 'deletion']

function buildReviewTree(files) {
  const root = {
    folders: new Map(),
    files: []
  }

  for (const file of files) {
    const parts = normalizeTreePath(file.label).split('/').filter(Boolean)
    if (parts.length <= 1) {
      root.files.push(file)
      continue
    }

    let current = root
    for (const folderName of parts.slice(0, -1)) {
      let child = current.folders.get(folderName)
      if (!child) {
        child = {
          label: folderName,
          folders: new Map(),
          files: []
        }
        current.folders.set(folderName, child)
      }
      current = child
    }
    current.files.push(file)
  }

  return createTreeChildren(root)
}

function createTreeChildren(node) {
  const folderItems = [...node.folders.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((folder) => new FolderItem(folder.label, createTreeChildren(folder), getPendingCount(getNodeFiles(folder))))

  const fileItems = node.files
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((file) => new FileItem(file))

  return [...folderItems, ...fileItems]
}

function getNodeFiles(node) {
  const files = [...node.files]
  for (const folder of node.folders.values()) {
    files.push(...getNodeFiles(folder))
  }
  return files
}

function createChangeKindItems(file) {
  const pendingBlocks = file.blocks.filter((block) => block.status === 'pending')
  return CHANGE_KIND_ORDER
    .map((changeKind) => {
      const blocks = pendingBlocks.filter((block) => block.changeKind === changeKind)
      return blocks.length > 0 ? new ChangeKindItem(file, changeKind, blocks) : null
    })
    .filter(Boolean)
}

function getPendingCount(files) {
  let count = 0
  for (const file of files) {
    count += file.blocks.filter((block) => block.status === 'pending').length
  }
  return count
}

function getChangeKindLabel(changeKind) {
  if (changeKind === 'addition') {
    return t('tree.added')
  }

  if (changeKind === 'deletion') {
    return t('tree.deleted')
  }

  return t('tree.replaced')
}

function getChangeKindIcon(changeKind) {
  if (changeKind === 'addition') {
    return getBundledIcon('review-added.svg')
  }

  if (changeKind === 'deletion') {
    return getBundledIcon('review-deleted.svg')
  }

  return getBundledIcon('review-replaced.svg')
}

function getBundledIcon(fileName) {
  return vscode.Uri.file(path.join(__dirname, '..', '..', 'images', fileName))
}

function normalizeTreePath(label) {
  return label.replace(/\\/g, '/')
}

module.exports = {
  ReviewBlockCodeLensProvider,
  ReviewTreeProvider
}
