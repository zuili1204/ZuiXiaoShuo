import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT_DIR = path.resolve(process.cwd(), 'src/skills/story-plan-workspace/scripts')
const VALIDATE = path.join(SCRIPT_DIR, 'validate-proposal.js')
const HEALTH = path.join(SCRIPT_DIR, 'check-plan-health.js')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-skill-'))
const created: string[] = []

function fixture(name: string, data: unknown): string {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
  created.push(file)
  return file
}

function run(script: string, args: string[]) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  let json: any = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    json = null
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

afterAll(() => {
  for (const file of created) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* 临时文件已清理 */
    }
  }
  try {
    fs.rmdirSync(tmpDir)
  } catch {
    /* 临时目录可能非空 */
  }
})

const seedProposal = {
  stage: 'seed',
  baseRevision: 'rev-1',
  payload: {
    titles: ['雾港来信', '第七码头'],
    genre: '都市悬疑',
    premise: '退役法医收到自己死亡证明',
    synopsis: '退役法医林岸收到一份写着明日日期的死亡证明，被迫重查十年前旧案。',
    coreConflict: '林岸想查清真相，但警队内部有人阻止',
    tone: '冷峻克制',
    audience: '悬疑推理读者',
    characters: [
      { name: '林岸', role: '主角', desire: '查清旧案', obstacle: '被警方停职' },
      { name: '周砚', role: '搭档', desire: '升职', obstacle: '旧案牵涉上司' },
      { name: '沈雪', role: '反派', desire: '掩盖真相', obstacle: '林岸步步紧逼' },
    ],
    worldAnchors: ['雾港终年多雾', '法医鉴定中心', '十年前沉船案'],
    sellingPoints: ['死亡证明倒计时', '法医细节硬核', '旧案新查反转'],
  },
  warnings: [],
}

const volumeChaptersProposal = {
  stage: 'volume-chapters',
  baseRevision: 'rev-1',
  payload: {
    volumeIndex: 0,
    chapters: [
      { id: 'ch-1', title: '死亡证明', hooks: ['证明上的日期是明天'], conflict: '林岸被停职', turn: '发现签名是自己', payoff: '决定私查', targetWordCount: 3000 },
      { id: 'ch-2', title: '雾中码头', hooks: ['码头监控缺失三分钟'], conflict: '证人失踪', turn: '找到旧案卷宗', payoff: '锁定第一嫌疑人', targetWordCount: 3000 },
    ],
  },
  warnings: [],
}

const goodPlan = {
  volumes: [
    {
      title: '第一卷 · 死亡证明',
      summary: '林岸被卷入自己的死亡预告',
      goal: '查清死亡证明来源',
      climax: '码头对峙',
      endingHook: '第二份死亡证明出现',
      estimatedChapters: 2,
      targetWordCount: 6000,
      chapters: [
        { id: 'ch-1', title: '死亡证明', hooks: ['日期是明天'], targetWordCount: 3000 },
        { id: 'ch-2', title: '雾中码头', hooks: ['监控缺失三分钟'], targetWordCount: 3000 },
      ],
    },
  ],
}

describe('validate-proposal.js', () => {
  it('合法立项提案通过并输出 ok:true', () => {
    const res = run(VALIDATE, ['--stage=seed', `--file=${fixture('seed-ok.json', seedProposal)}`])
    expect(res.status).toBe(0)
    expect(res.json?.ok).toBe(true)
    expect(res.json?.errors).toEqual([])
  })

  it('缺字段的立项提案失败并给出字段路径', () => {
    const bad = { stage: 'seed', baseRevision: 'r', payload: { titles: [] }, warnings: [] }
    const res = run(VALIDATE, ['--stage=seed', `--file=${fixture('seed-bad.json', bad)}`])
    expect(res.status).toBe(1)
    expect(res.json?.ok).toBe(false)
    expect(res.json?.errors.some((e: string) => e.startsWith('payload.titles'))).toBe(true)
  })

  it('已写章出现在卷章纲中会被拦截', () => {
    const res = run(VALIDATE, [
      '--stage=volume-chapters',
      `--file=${fixture('vol.json', volumeChaptersProposal)}`,
      '--written-ids=ch-1',
    ])
    expect(res.status).toBe(1)
    expect(res.json?.errors.some((e: string) => e.includes('已写章不可写入'))).toBe(true)
  })

  it('同一卷章名重复会被拦截', () => {
    const dup = JSON.parse(JSON.stringify(volumeChaptersProposal))
    dup.payload.chapters[1].title = '死亡证明'
    const res = run(VALIDATE, ['--stage=volume-chapters', `--file=${fixture('vol-dup.json', dup)}`])
    expect(res.status).toBe(1)
    expect(res.json?.errors.some((e: string) => e.includes('章名重复'))).toBe(true)
  })

  it('未知阶段按参数错误退出 2', () => {
    const res = run(VALIDATE, ['--stage=unknown', `--file=${fixture('x.json', {})}`])
    expect(res.status).toBe(2)
  })
})

describe('check-plan-health.js', () => {
  it('结构完好的大纲无 blocking', () => {
    const res = run(HEALTH, [`--file=${fixture('plan-ok.json', goodPlan)}`])
    expect(res.status).toBe(0)
    expect(res.json?.ok).toBe(true)
    expect(res.json?.summary.blocking).toBe(0)
  })

  it('未写章缺 hooks 报 blocking', () => {
    const bad = JSON.parse(JSON.stringify(goodPlan))
    bad.volumes[0].chapters[1].hooks = []
    const res = run(HEALTH, [`--file=${fixture('plan-nohook.json', bad)}`])
    expect(res.status).toBe(1)
    expect(res.json?.findings.some((f: any) => f.severity === 'blocking' && f.type === 'hook-density')).toBe(true)
  })

  it('已写章缺 hooks 时跳过该检查', () => {
    const plan = JSON.parse(JSON.stringify(goodPlan))
    plan.volumes[0].chapters[1].hooks = []
    const res = run(HEALTH, [`--file=${fixture('plan-written.json', plan)}`, '--written-ids=ch-2'])
    expect(res.status).toBe(0)
    expect(res.json?.findings.some((f: any) => f.type === 'hook-density')).toBe(false)
  })

  it('接受 payload 包装与扁平 chapters', () => {
    const flat = { payload: { chapters: [{ id: 'c1', title: '开篇', hooks: ['钩子'], targetWordCount: 2000 }] } }
    const res = run(HEALTH, [`--file=${fixture('plan-flat.json', flat)}`])
    expect(res.status).toBe(0)
    expect(res.json?.summary.volumes).toBe(1)
    expect(res.json?.summary.chapters).toBe(1)
  })

  it('卷字数偏差超过 40% 报 blocking', () => {
    const drift = JSON.parse(JSON.stringify(goodPlan))
    drift.volumes[0].targetWordCount = 20000
    const res = run(HEALTH, [`--file=${fixture('plan-drift.json', drift)}`])
    expect(res.status).toBe(1)
    expect(res.json?.findings.some((f: any) => f.type === 'budget' && f.severity === 'blocking')).toBe(true)
  })
})
