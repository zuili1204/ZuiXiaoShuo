import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// 规划提案校验 IPC 的主进程实现。
// 复用 src/skills/story-plan-workspace/scripts 下的确定性脚本：
// 渲染层传结构与已写章 id，这里写临时文件后以纯 Node 子进程运行，
// 把脚本 JSON 输出原样回传。脚本不可用时抛错，由渲染层决定是否降级。

export interface PlanValidationInput {
  stage: string
  proposal: unknown
  writtenIds?: string[]
}

export interface PlanValidationResult {
  ok: boolean
  stage?: string
  errors: string[]
}

export interface PlanHealthInput {
  plan: unknown
  writtenIds?: string[]
}

export interface PlanHealthFinding {
  severity: 'blocking' | 'warning' | 'info'
  type: string
  location: string
  message: string
}

export interface PlanHealthResult {
  ok: boolean
  summary: { volumes: number; chapters: number; findings: number; blocking: number; warning: number }
  findings: PlanHealthFinding[]
}

function scriptPath(appRoot: string, name: string): string {
  return join(appRoot, 'src', 'skills', 'story-plan-workspace', 'scripts', name)
}

function runScript(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // dev 下 process.execPath 是 Electron 二进制，ELECTRON_RUN_AS_NODE 置 1 后按纯 Node 运行
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 2, stdout, stderr }))
  })
}

async function withTempJson<T>(data: unknown, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'zxs-plan-'))
  try {
    const file = join(dir, 'proposal.json')
    await writeFile(file, JSON.stringify(data), 'utf8')
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function parseStdout<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new Error(`${label}输出解析失败：${stdout.slice(0, 300)}`)
  }
}

export async function validatePlanProposal(input: PlanValidationInput, appRoot: string): Promise<PlanValidationResult> {
  if (!input || typeof input.stage !== 'string' || !input.stage.trim()) {
    throw new Error('规划校验缺少 stage')
  }
  return withTempJson(input.proposal, async (file) => {
    const args = [`--stage=${input.stage}`, `--file=${file}`]
    const written = (input.writtenIds ?? []).filter((id) => typeof id === 'string' && id.trim())
    if (written.length) args.push(`--written-ids=${written.join(',')}`)

    const res = await runScript(scriptPath(appRoot, 'validate-proposal.js'), args)
    if (res.code === 2) {
      throw new Error(`提案校验脚本运行失败：${res.stderr.trim().slice(0, 300)}`)
    }
    const parsed = parseStdout<PlanValidationResult>(res.stdout, '提案校验脚本')
    return {
      ok: !!parsed.ok && res.code === 0,
      stage: parsed.stage ?? input.stage,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    }
  })
}

export async function checkPlanHealth(input: PlanHealthInput, appRoot: string): Promise<PlanHealthResult> {
  return withTempJson(input.plan, async (file) => {
    const args = [`--file=${file}`]
    const written = (input.writtenIds ?? []).filter((id) => typeof id === 'string' && id.trim())
    if (written.length) args.push(`--written-ids=${written.join(',')}`)

    const res = await runScript(scriptPath(appRoot, 'check-plan-health.js'), args)
    if (res.code === 2) {
      throw new Error(`大纲体检脚本运行失败：${res.stderr.trim().slice(0, 300)}`)
    }
    const parsed = parseStdout<PlanHealthResult>(res.stdout, '大纲体检脚本')
    return {
      ok: !!parsed.ok && res.code === 0,
      summary: parsed.summary,
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    }
  })
}
