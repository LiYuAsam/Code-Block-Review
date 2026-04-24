const vscode = require('vscode')

class ReviewProfiler {
  constructor() {
    this.output = vscode.window.createOutputChannel('Code Block Review Profiler')
    this.enabled = this.getEnabled()
    this.outputShown = false
  }

  dispose() {
    this.output.dispose()
  }

  getEnabled() {
    return Boolean(vscode.workspace.getConfiguration('codexReview.profiler').get('enabled', false))
  }

  refreshConfiguration() {
    this.enabled = this.getEnabled()
  }

  show(preserveFocus = true) {
    this.output.show(preserveFocus)
    this.outputShown = true
  }

  logSnapshot(label, extra = {}) {
    if (!this.enabled) {
      return
    }

    const memory = getProfilerSnapshot()
    const timestamp = new Date().toISOString()
    const details = Object.entries(extra)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')

    if (!this.outputShown) {
      this.show(true)
    }

    this.output.appendLine(
      `[${timestamp}] ${label} rss=${formatProfilerValue(memory.rssMb)}MB heap=${formatProfilerValue(memory.heapUsedMb)}/${formatProfilerValue(memory.heapTotalMb)}MB external=${formatProfilerValue(memory.externalMb)}MB${details ? ` ${details}` : ''}`
    )
  }

  startMark(label, extra = {}) {
    if (!this.enabled) {
      return null
    }

    this.logSnapshot(`${label}:start`, extra)
    return {
      label,
      startedAt: process.hrtime.bigint(),
      cpuUsage: process.cpuUsage()
    }
  }

  finishMark(mark, extra = {}) {
    if (!mark) {
      return
    }

    const elapsedMs = Number(process.hrtime.bigint() - mark.startedAt) / 1e6
    const cpu = process.cpuUsage(mark.cpuUsage)
    this.logSnapshot(`${mark.label}:end`, {
      elapsedMs: formatProfilerValue(elapsedMs),
      cpuUserMs: formatProfilerValue(cpu.user / 1000),
      cpuSystemMs: formatProfilerValue(cpu.system / 1000),
      ...extra
    })
  }
}

function formatProfilerValue(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(1)
    : '0.0'
}

function getProfilerSnapshot() {
  const memory = process.memoryUsage()
  return {
    rssMb: memory.rss / (1024 * 1024),
    heapUsedMb: memory.heapUsed / (1024 * 1024),
    heapTotalMb: memory.heapTotal / (1024 * 1024),
    externalMb: memory.external / (1024 * 1024)
  }
}

module.exports = {
  ReviewProfiler
}
