import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityGate } from '../../shared/types'

// P2-1：质量门禁 IPC 的主进程实现。
// 复用 src/skills/story-review 的两个确定性 deslop 脚本（check-ai-patterns / check-degeneration），
// 把渲染层传来的正文写临时文件后以子进程运行（--json --fail-on=blocking），
// 合并 findings 映射为 QualityGate。渲染层 runQualityGate 经 preload quality.check 调到这里，
// 本模块抛错时渲染层已有启发式降级兜底（quality-service.ts）。

export interface DeslopFinding {
  file: string
  line: number
  column: number
  type: string
  severity: 'blocking' | 'advisory'
  message: string
  excerpt: string
  source: 'ai-patterns' | 'degeneration' | 'style-metrics'
}

// 脚本退出码：0=无 blocking，1=有 blocking（--fail-on=blocking 时仍会输出全部 findings），
// 2=用法/文件读取错误（视为脚本运行失败）。
function runScript(scriptPath: string, filePath: string, source: DeslopFinding['source']): Promise<DeslopFinding[]> {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE：dev 下 process.execPath 是 Electron 二进制，
    // 置 1 后按纯 Node 运行脚本；在 vitest/node 环境下该变量无副作用。
    const child = spawn(process.execPath, [scriptPath, '--json', '--fail-on=blocking', filePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 2) {
        reject(new Error(`deslop 脚本运行失败（exit 2）: ${scriptPath} ${err.trim().slice(0, 200)}`))
        return
      }
      try {
        const parsed = JSON.parse(out) as { findings?: Omit<DeslopFinding, 'source'>[] }
        resolve((parsed.findings ?? []).map((f) => ({ ...f, source })))
      } catch (e) {
        reject(new Error(`deslop 脚本输出解析失败: ${String(e)}`))
      }
    })
  })
}

/**
 * IMP-05：接入文风度量（与 scripts/style-check.js 共用同一算法库，避免两套实现漂移）。
 *
 * 之前只有 10 条 regex 的启发式检查，分析报告中发现的硬伤（直角引号、章末升华、英文引号）
 * 一个都拦不住。这里把 CLI 验证过的指标搬进运行时门禁。
 *
 * 兜底：算法库加载或计算失败时返回空数组——绝不因度量故障阻断写作主流程。
 */
function loadStyleLib(appRoot: string): any | null {
  try {
    const p = join(appRoot, 'scripts', 'style-metrics-lib.cjs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p)
  } catch (e) {
    console.warn('[quality] style-metrics-lib 加载失败，跳过文风指标检查:', String(e).slice(0, 200))
    return null
  }
}

export function runStyleMetrics(text: string, appRoot: string): DeslopFinding[] {
  const lib = loadStyleLib(appRoot)
  if (!lib) return []
  try {
    const metrics = lib.computeMetrics(text)
    const gate = lib.gateChapter(metrics)
    const mk = (severity: 'blocking' | 'advisory', message: string): DeslopFinding => ({
      file: 'chapter.md',
      line: 1,
      column: 1,
      type: 'style-metrics',
      severity,
      message,
      excerpt: '',
      source: 'style-metrics',
    })
    // 运行时只上报 blocking（零歧义硬伤：引号混用、章末升华）。
    //
    // warning（密度/规模类）刻意不上报：质检是在"边写边保存"时触发的，
    // 未完成的章节必然字数不足、比喻密度波动，上报只会产生噪音并扣分误伤。
    // 密度类指标的诊断交给开发期 CLI（scripts/style-check.js）。
    return gate.blocking.map((b: string) => mk('blocking', b))
  } catch (e) {
    console.warn('[quality] 文风指标计算失败:', String(e).slice(0, 200))
    return []
  }
}

// appRoot：dev 下即项目根（app.getAppPath()），脚本随 src/ 分发
export function scriptPaths(appRoot: string) {
  return {
    aiPatterns: join(appRoot, 'src', 'skills', 'story-review', 'scripts', 'check-ai-patterns.js'),
    degeneration: join(appRoot, 'src', 'skills', 'story-review', 'scripts', 'check-degeneration.js'),
  }
}

export async function runDeslopScripts(text: string, appRoot: string): Promise<DeslopFinding[]> {
  const dir = await mkdtemp(join(tmpdir(), 'zxs-quality-'))
  try {
    const file = join(dir, 'chapter.md')
    await writeFile(file, text, 'utf8')
    const scripts = scriptPaths(appRoot)
    const [ai, degen] = await Promise.all([
      runScript(scripts.aiPatterns, file, 'ai-patterns'),
      runScript(scripts.degeneration, file, 'degeneration'),
    ])
    return [...ai, ...degen]
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// findings → QualityGate 映射（纯函数）：
// blocking（复读/截断/占位拒绝语/核心 AI 句式，命中即重写）→ 不通过门禁；
// advisory（密度型提示，交人工/LLM 判）→ 计入扣分但不拦截。
// deslopTag 只看 AI 味（ai-patterns）脚本是否有 blocking；退化类 blocking 单独计入 degenerationHits。
export function mapFindingsToGate(findings: DeslopFinding[]): QualityGate {
  const blocking = findings.filter((f) => f.severity === 'blocking')
  const advisory = findings.filter((f) => f.severity === 'advisory')
  const aiBlocking = blocking.filter((f) => f.source === 'ai-patterns')
  const score = Math.max(0, 100 - blocking.length * 15 - advisory.length * 3)
  const listed = blocking.slice(0, 8).map((f) => `第${f.line}行 [${f.type}] ${f.message}（${f.excerpt}）`)
  const report =
    blocking.length > 0
      ? `脚本检测：blocking ${blocking.length} 处、提示 ${advisory.length} 处；${listed.join('；')}${blocking.length > 8 ? `；等共 ${blocking.length} 处` : ''}`
      : `脚本检测：无 blocking 问题，提示 ${advisory.length} 处`
  return {
    score,
    passed: blocking.length === 0,
    deslopTag: aiBlocking.length === 0,
    aiPatternHits: findings.filter((f) => f.source === 'ai-patterns').length,
    degenerationHits: findings.filter((f) => f.source === 'degeneration').length,
    report,
    checkedAt: new Date().toISOString(),
    // 行级发现透传（截断到 50 条，避免极端脏稿撑爆 IPC/面板）
    findings: findings.slice(0, 50).map((f) => ({
      line: f.line,
      type: f.type,
      severity: f.severity,
      message: f.message,
      excerpt: f.excerpt,
      source: f.source,
    })),
  }
}

// IPC 入口：正文过短与启发式评分保持同一口径（quality-service.estimateQualityGate）
export async function checkQuality(text: string, appRoot: string): Promise<QualityGate> {
  if (!text || text.trim().length < 50) {
    return {
      score: 0,
      passed: false,
      deslopTag: false,
      aiPatternHits: 0,
      degenerationHits: 0,
      report: '正文过短（少于 50 字），未运行脚本检测',
      checkedAt: new Date().toISOString(),
      findings: [],
    }
  }
  // IMP-05：deslop 脚本 + 文风指标并行；后者为纯计算，无子进程开销
  const [deslop, style] = await Promise.all([
    runDeslopScripts(text, appRoot),
    Promise.resolve(runStyleMetrics(text, appRoot)),
  ])
  return mapFindingsToGate([...deslop, ...style])
}
