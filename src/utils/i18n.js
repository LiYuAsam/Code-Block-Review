const vscode = require('vscode')

const locale = (vscode.env.language || 'en').toLowerCase()
const language = locale.startsWith('zh') ? 'zh' : 'en'

const messages = {
  en: {
    'action.startReview': 'Start Review',
    'action.skip': 'Skip',
    'action.accept': 'Accept',
    'action.reject': 'Reject',
    'action.prevBlock': 'Prev Block',
    'action.nextBlock': 'Next Block',
    'action.review': 'Review',

    'status.ready': '$(diff) Code Block Review: {count} Ready',
    'status.capturing': '$(record) Code Block Review: Capturing {count}',
    'status.pending': '$(diff) Code Block Review: {count} Pending',
    'status.start': '$(sparkle) Code Block Review: Start',
    'status.baselineSyncing': '$(sync~spin) Code Block Review: Baseline Syncing',
    'status.baselineFailed': '$(warning) Code Block Review: Baseline Failed',
    'status.baselinePending': '$(pulse) Code Block Review: Baseline Pending',
    'status.autoArmed': '$(pulse) Code Block Review: Auto Armed',
    'tooltip.readyIndefinite': 'Open review now. Auto-dismiss is disabled, so this capture will keep waiting until you review it or run Complete Review to skip it.',
    'tooltip.readyTimed': 'Open review now. If you do nothing, this automatic capture will be dismissed in {remaining} and the current workspace will become the new baseline.',
    'tooltip.openAutoCaptureReview': 'Open review mode for this automatic capture',
    'tooltip.stopCapture': 'Stop capture and enter review mode',
    'tooltip.openReviewPanel': 'Open the Code Block Review Panel',
    'tooltip.autoMonitoring': 'Automatic capture is continuously monitoring for short bursts of large or bulk edits.',
    'tooltip.startCapture': 'Start a review capture session',
    'tooltip.baselineReady': 'Auto-capture baseline is ready with {count} files.',
    'tooltip.baselineNotReady': 'Auto-capture baseline has not finished syncing yet.',

    'tree.autoArmed': 'Auto Armed: continuously monitoring for short bursts of large or bulk edits.',
    'tree.noSession': 'No active review session. Run "Code Block Review: Start Review Session".',
    'tree.autoReady': 'Automatic capture is ready. Click the status bar or run "Stop Capture And Review" to open review.',
    'tree.capturing': 'Capture is active. Edit some files, then stop capture to review.',
    'tree.noBlocks': 'No review blocks found yet.',
    'tree.pending': '{count} pending',
    'tree.accepted': '{count} accepted',
    'tree.openPanel': 'Open Review Panel',
    'tree.openBlock': 'Open Review Block',

    'codelens.acceptTooltip': 'Accept this review block and jump to the next pending block',
    'codelens.rejectTooltip': 'Reject this review block and jump to the next pending block',
    'codelens.prevTooltip': 'Jump to the previous pending review block',
    'codelens.nextTooltip': 'Jump to the next pending review block',
    'codelens.reviewTooltip': 'Open the dedicated review panel for this block',
    'decorations.currentReviewTooltip': 'Currently selected in Code Block Review Panel',
    'deletedPreview.unavailable': '// Deleted file preview is no longer available.',
    'hover.state': 'State',
    'hover.type': 'Type',
    'hover.current': 'Current',
    'hover.baseline': 'Baseline',
    'hover.truncated': '... truncated; open the review panel for the full block.',

    'message.sessionAlreadyActive': 'A review session is already active.',
    'message.captureStarted': 'Code Block Review capture started.',
    'message.noCaptureSession': 'There is no capture session to stop.',
    'message.noBlocksSessionClosed': 'No review blocks were found. Session closed.',
    'message.enteredReview': 'Code Block Review entered review mode with {count} pending {blockWord}.',
    'message.autoCaptured': 'Code Block Review captured {count} pending {blockWord}.{suffix}',
    'message.autoDismissDisabledSuffix': ' Auto-dismiss is disabled, so this session will wait until you review or skip it.',
    'message.largeSessionWarning': 'Code Block Review is holding a large review session ({reasons}). Review or skip it soon to release memory and temporary snapshot files.',
    'message.gitStateChanged': 'Code Block Review capture was closed because the Git repository state changed.',
    'message.noPendingBlocks': 'No pending review blocks are available.',
    'message.failedToSave': 'Failed to save {file}.',
    'message.couldNotFindBlock': 'Could not find the selected review block.',
    'message.failedToRejectBlock': 'Failed to reject block.',
    'message.rejectNoChange': 'Reject did not change the file. The block may already match the baseline.',
    'message.failedToRejectFile': 'Failed to reject file.',
    'message.failedToRejectNamedFile': 'Failed to reject {file}.',
    'message.acceptedRemaining': 'All remaining pending review blocks were accepted.',
    'message.rejectedRemaining': 'All remaining pending review blocks were rejected.',
    'message.allHandled': 'All review blocks have been handled. Session closed.',


    'unit.pendingBlocks': '{count} pending blocks',
    'unit.reviewText': '{size} of review block text',
    'unit.snapshots': '{size} of baseline snapshots',
    'unit.time.minutesSeconds': '{minutes}m {seconds}s',
    'unit.time.seconds': '{seconds}s',
    'unit.block.singular': 'block',
    'unit.block.plural': 'blocks'
  },
  zh: {
    'action.startReview': '开始 Review',
    'action.skip': '跳过',
    'action.accept': '接受',
    'action.reject': '拒绝',
    'action.prevBlock': '上一块',
    'action.nextBlock': '下一块',
    'action.review': 'Review',

    'status.ready': '$(diff) Code Block Review：{count} 个待 Review',
    'status.capturing': '$(record) Code Block Review：捕获中 {count}',
    'status.pending': '$(diff) Code Block Review：{count} 个待处理',
    'status.start': '$(sparkle) Code Block Review：开始',
    'status.baselineSyncing': '$(sync~spin) Code Block Review：Baseline 同步中',
    'status.baselineFailed': '$(warning) Code Block Review：Baseline 同步失败',
    'status.baselinePending': '$(pulse) Code Block Review：Baseline 待同步',
    'status.autoArmed': '$(pulse) Code Block Review：自动监测中',
    'tooltip.readyIndefinite': '立即打开 review。自动超时已关闭，本次捕获会一直等待，直到你进入 review 或运行 Complete Review 跳过。',
    'tooltip.readyTimed': '立即打开 review。如果不处理，自动捕获会在 {remaining} 后静默退出，并把当前工作区同步为新的 baseline。',
    'tooltip.openAutoCaptureReview': '打开本次自动捕获的 review 模式',
    'tooltip.stopCapture': '停止捕获并进入 review 模式',
    'tooltip.openReviewPanel': '打开 Code Block Review 面板',
    'tooltip.autoMonitoring': '自动捕获正在持续监测短时间内的大改动或批量改动。',
    'tooltip.startCapture': '开始一个 review 捕获会话',
    'tooltip.baselineReady': '自动捕获 baseline 已就绪，共 {count} 个文件。',
    'tooltip.baselineNotReady': '自动捕获 baseline 尚未完成同步。',

    'tree.autoArmed': '自动监测中：正在持续监测短时间内的大改动或批量改动。',
    'tree.noSession': '当前没有活动的 review 会话。可运行 “Code Block Review: Start Review Session”。',
    'tree.autoReady': '自动捕获已就绪。点击状态栏，或运行 “Stop Capture And Review” 打开 review。',
    'tree.capturing': '捕获中。修改一些文件后，停止捕获即可进入 review。',
    'tree.noBlocks': '暂未发现 review 代码块。',
    'tree.pending': '{count} 个待处理',
    'tree.accepted': '{count} 个已接受',
    'tree.openPanel': '打开 Review 面板',
    'tree.openBlock': '打开 Review 代码块',

    'codelens.acceptTooltip': '接受这个 review 代码块，并跳到下一个待处理代码块',
    'codelens.rejectTooltip': '拒绝这个 review 代码块，并跳到下一个待处理代码块',
    'codelens.prevTooltip': '跳到上一个待处理 review 代码块',
    'codelens.nextTooltip': '跳到下一个待处理 review 代码块',
    'codelens.reviewTooltip': '打开这个代码块的独立 review 面板',
    'decorations.currentReviewTooltip': '当前已在 Code Block Review 面板中选中',
    'deletedPreview.unavailable': '// 删除文件预览已不可用。',
    'hover.state': '状态',
    'hover.type': '类型',
    'hover.current': '当前代码',
    'hover.baseline': 'Baseline',
    'hover.truncated': '... 内容已截断；打开 review 面板查看完整代码块。',

    'message.sessionAlreadyActive': '当前已有活动的 review 会话。',
    'message.captureStarted': 'Code Block Review 已开始捕获。',
    'message.noCaptureSession': '当前没有可停止的捕获会话。',
    'message.noBlocksSessionClosed': '没有发现 review 代码块，会话已关闭。',
    'message.enteredReview': 'Code Block Review 已进入 review 模式，共 {count} 个待处理代码块。',
    'message.autoCaptured': 'Code Block Review 捕获到 {count} 个待处理代码块。{suffix}',
    'message.autoDismissDisabledSuffix': '自动超时已关闭，本次会话会一直等待，直到你 review 或跳过。',
    'message.largeSessionWarning': 'Code Block Review 正在保留一个较大的 review 会话（{reasons}）。建议尽快 review 或跳过，以释放内存和临时 baseline 快照文件。',
    'message.gitStateChanged': '检测到 Git 仓库状态变化，Code Block Review 已关闭本次捕获。',
    'message.noPendingBlocks': '当前没有可处理的 review 代码块。',
    'message.failedToSave': '保存 {file} 失败。',
    'message.couldNotFindBlock': '找不到选中的 review 代码块。',
    'message.failedToRejectBlock': '拒绝代码块失败。',
    'message.rejectNoChange': '拒绝操作没有改变文件。该代码块可能已经和 baseline 一致。',
    'message.failedToRejectFile': '拒绝文件失败。',
    'message.failedToRejectNamedFile': '拒绝 {file} 失败。',
    'message.acceptedRemaining': '所有剩余待处理 review 代码块已接受。',
    'message.rejectedRemaining': '所有剩余待处理 review 代码块已拒绝。',
    'message.allHandled': '所有 review 代码块都已处理，会话已关闭。',


    'unit.pendingBlocks': '{count} 个待处理代码块',
    'unit.reviewText': '{size} review 代码文本',
    'unit.snapshots': '{size} baseline 快照',
    'unit.time.minutesSeconds': '{minutes} 分 {seconds} 秒',
    'unit.time.seconds': '{seconds} 秒',
    'unit.block.singular': 'block',
    'unit.block.plural': 'blocks'
  }
}

// Looks up localized strings and interpolates simple {name} placeholders.
function t(key, values = {}) {
  const template = messages[language][key] ?? messages.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return String(values[name])
    }

    return match
  })
}

// Selects the singular/plural message key for count-based UI copy.
function pluralKey(count, singularKey, pluralKeyName) {
  return count === 1 ? t(singularKey) : t(pluralKeyName)
}

module.exports = {
  t,
  pluralKey,
  language
}
