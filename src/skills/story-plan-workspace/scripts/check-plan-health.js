#!/usr/bin/env node
/**
 * 大纲结构健康检查（确定性）
 * 用法：node scripts/check-plan-health.js --file=<json> [--written-ids=id1,id2]
 * 输入：{ volumes: [{ title, summary, goal, climax, endingHook, estimatedChapters, targetWordCount, chapters: [...] }] }
 * 退出码：0 无 blocking；1 存在 blocking；2 参数/读取错误
 */
const fs = require('fs')

function parseArgs(argv) {
  const out = {}
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isText(v) {
  return typeof v === 'string' && v.trim().length > 0
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0
}

function main() {
  const args = parseArgs(process.argv)
  const file = args.file
  if (!file) {
    console.error('用法：node scripts/check-plan-health.js --file=<json> [--written-ids=id1,id2]')
    process.exit(2)
  }

  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`读取或解析失败：${err.message}`)
    process.exit(2)
  }

  const root = isObject(data.payload) ? data.payload : data
  const writtenIds = new Set(
    String(args['written-ids'] || (root.writtenChapterIds || []).join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )

  let volumes = Array.isArray(root.volumes) ? root.volumes : []
  if (!volumes.length && Array.isArray(root.chapters)) {
    volumes = [{ title: '未分卷', chapters: root.chapters }]
  }

  const findings = []
  const add = (severity, type, location, message) => {
    findings.push({ severity, type, location, message })
  }

  if (!volumes.length) {
    add('blocking', 'structure', '全书', '没有任何卷；至少需要 1 卷才能体检')
  }

  const allChapterIds = new Map()
  volumes.forEach((vol, vi) => {
    const vp = `第 ${vi + 1} 卷`
    if (!isObject(vol)) {
      add('blocking', 'structure', vp, '卷数据不是对象')
      return
    }
    if (!isText(vol.title)) add('blocking', 'structure', vp, '卷名为空')
    if (!isText(vol.summary)) add('warning', 'structure', vp, '缺少卷纲 summary')
    if (!isText(vol.goal)) add('warning', 'structure', vp, '缺少卷目标 goal')
    if (!isText(vol.climax)) add('warning', 'structure', vp, '缺少卷末高潮 climax')
    if (!isText(vol.endingHook)) add('warning', 'escalation', vp, '缺少卷尾钩子 endingHook')

    const chapters = Array.isArray(vol.chapters) ? vol.chapters : []
    if (!chapters.length) {
      add('warning', 'structure', vp, '本卷还没有章节')
    }

    const titles = new Set()
    let wordSum = 0
    chapters.forEach((ch, ci) => {
      const cp = `${vp} 第 ${ci + 1} 章`
      if (!isObject(ch)) {
        add('blocking', 'structure', cp, '章数据不是对象')
        return
      }
      const id = ch.id || ch.chapterId || ''
      const isWritten = id && writtenIds.has(id)
      if (id) {
        if (allChapterIds.has(id)) {
          add('warning', 'duplicate', cp, `章 id 重复：${id}（另一处：${allChapterIds.get(id)}）`)
        } else {
          allChapterIds.set(id, cp)
        }
      }
      if (!isText(ch.title)) {
        add('blocking', 'structure', cp, '章名为空')
      } else if (titles.has(ch.title)) {
        add('blocking', 'duplicate', cp, `同卷章名重复：${ch.title}`)
      } else {
        titles.add(ch.title)
      }
      if (!isWritten && (!Array.isArray(ch.hooks) || ch.hooks.filter(isText).length === 0)) {
        add('blocking', 'hook-density', cp, '未写章没有任何 hooks')
      }
      if (isPositiveInt(ch.targetWordCount)) {
        wordSum += ch.targetWordCount
      } else {
        add('warning', 'budget', cp, '缺少有效的 targetWordCount')
      }
    })

    if (isPositiveInt(vol.targetWordCount) && wordSum > 0) {
      const drift = Math.abs(wordSum - vol.targetWordCount) / vol.targetWordCount
      if (drift > 0.4) {
        add('blocking', 'budget', vp, `章字数合计 ${wordSum} 与卷目标 ${vol.targetWordCount} 偏差 ${(drift * 100).toFixed(0)}%`)
      } else if (drift > 0.2) {
        add('warning', 'budget', vp, `章字数合计 ${wordSum} 与卷目标 ${vol.targetWordCount} 偏差 ${(drift * 100).toFixed(0)}%`)
      }
    }
    if (isPositiveInt(vol.estimatedChapters) && chapters.length > 0 && chapters.length !== vol.estimatedChapters) {
      add(
        'warning',
        'budget',
        vp,
        `已规划 ${chapters.length} 章，与预计章数 ${vol.estimatedChapters} 不一致`
      )
    }
  })

  for (let i = 1; i < volumes.length; i++) {
    const prev = volumes[i - 1]
    const curr = volumes[i]
    if (!isObject(prev) || !isObject(curr)) continue
    if (isText(prev.endingHook) && prev.endingHook === curr.endingHook) {
      add('warning', 'escalation', `第 ${i + 1} 卷`, '与上一卷的卷尾钩子完全重复，缺少升级')
    }
    if (isText(prev.goal) && prev.goal === curr.goal) {
      add('warning', 'escalation', `第 ${i + 1} 卷`, '与上一卷的卷目标完全重复，缺少升级')
    }
  }

  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const result = {
    ok: blocking === 0,
    summary: {
      volumes: volumes.length,
      chapters: Array.from(allChapterIds.keys()).length,
      findings: findings.length,
      blocking,
      warning: findings.filter((f) => f.severity === 'warning').length,
    },
    findings,
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main()
