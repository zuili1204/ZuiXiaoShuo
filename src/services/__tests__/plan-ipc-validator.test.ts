import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { checkPlanHealth, validatePlanProposal } from '../../../electron/services/plan-validator'

const appRoot = process.cwd()

const seed = {
  stage: 'seed',
  baseRevision: 'rev-1',
  payload: {
    titles: ['雾港来信'],
    genre: '都市悬疑',
    premise: '退役法医收到自己的死亡证明',
    synopsis: '林岸被迫重查旧案。',
    coreConflict: '林岸想查真相，但警队有人阻止',
    characters: [
      { name: '林岸', role: '主角', desire: '查清旧案', obstacle: '被停职' },
      { name: '周砚', role: '配角', desire: '升职', obstacle: '上司涉案' },
      { name: '沈雪', role: '反派', desire: '掩盖真相', obstacle: '林岸逼近' },
    ],
    worldAnchors: ['雾港多雾', '法医中心', '旧案卷宗'],
    sellingPoints: ['倒计时', '法医细节', '旧案反转'],
    tone: '冷峻',
    audience: '悬疑读者',
  },
  warnings: [],
}

const plan = {
  volumes: [
    {
      title: '第一卷',
      summary: '卷纲',
      goal: '查清来源',
      climax: '码头对峙',
      endingHook: '第二份证明出现',
      estimatedChapters: 1,
      targetWordCount: 3000,
      chapters: [{ id: 'ch-1', title: '死亡证明', hooks: ['日期是明天'], targetWordCount: 3000 }],
    },
  ],
}

describe('plan-validator IPC 包装', () => {
  it('validatePlanProposal 返回脚本结构与 ok', async () => {
    const res = await validatePlanProposal({ stage: 'seed', proposal: seed }, appRoot)
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
  })

  it('validatePlanProposal 翻译脚本失败与已写章拦截', async () => {
    const bad = {
      ...seed,
      payload: { ...seed.payload, characters: [] },
    }
    const res = await validatePlanProposal({ stage: 'seed', proposal: bad }, appRoot)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('characters'))).toBe(true)

    const vol = {
      stage: 'volume-chapters',
      baseRevision: 'rev-1',
      payload: {
        volumeIndex: 0,
        chapters: [
          { id: 'ch-1', title: '开篇', hooks: ['钩'], conflict: 'c', turn: 't', payoff: 'p', targetWordCount: 3000 },
        ],
      },
      warnings: [],
    }
    const blocked = await validatePlanProposal({ stage: 'volume-chapters', proposal: vol, writtenIds: ['ch-1'] }, appRoot)
    expect(blocked.ok).toBe(false)
    expect(blocked.errors.some((e) => e.includes('已写章不可写入'))).toBe(true)
  })

  it('stage 缺失时抛错（参数错误）', async () => {
    await expect(validatePlanProposal({ stage: '', proposal: seed }, appRoot)).rejects.toThrow('stage')
  })

  it('checkPlanHealth 返回摘要与 blocking', async () => {
    const ok = await checkPlanHealth({ plan }, appRoot)
    expect(ok.ok).toBe(true)
    expect(ok.summary.volumes).toBe(1)
    expect(ok.summary.chapters).toBe(1)

    const broken = JSON.parse(JSON.stringify(plan))
    broken.volumes[0].chapters[0].hooks = []
    const bad = await checkPlanHealth({ plan: broken }, appRoot)
    expect(bad.ok).toBe(false)
    expect(bad.findings.some((f) => f.type === 'hook-density' && f.severity === 'blocking')).toBe(true)
  })

  it('脚本路径基于 appRoot 的 src/skills 目录', () => {
    expect(path.join(appRoot, 'src', 'skills', 'story-plan-workspace', 'scripts', 'validate-proposal.js')).toContain(
      'story-plan-workspace',
    )
  })
})
