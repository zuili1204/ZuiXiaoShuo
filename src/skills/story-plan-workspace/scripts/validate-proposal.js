#!/usr/bin/env node
/**
 * 规划提案结构校验（确定性）
 * 用法：node scripts/validate-proposal.js --stage=<stage> --file=<json> [--written-ids=id1,id2]
 * 退出码：0 通过；1 校验失败；2 参数/读取错误
 */
const fs = require('fs')

const STAGES = new Set([
  'seed',
  'seed-assist',
  'master',
  'volume-chapters',
  'chapter-detail',
  'review',
  'calibrate',
  'import-outline',
])
const SEVERITIES = new Set(['blocking', 'warning', 'info'])
const ISSUE_TYPES = new Set([
  'pacing',
  'logic',
  'motivation',
  'repetition',
  'setup-payoff',
  'hook-density',
  'volume-escalation',
  'chapter-closure',
  'serial-unit',
  'relationship-state',
])

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

function isTextArray(v, min = 0, max = Infinity) {
  return (
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every((item) => isText(item))
  )
}

function isInt(v, min, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(v) && v >= min && v <= max
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`)
}

function validateEnvelope(data, stage, errors) {
  if (!isObject(data)) {
    add(errors, '$', '提案必须是 JSON 对象')
    return false
  }
  if (data.stage !== stage) {
    add(errors, 'stage', `应为 "${stage}"，实际为 ${JSON.stringify(data.stage)}`)
  }
  if (!isText(data.baseRevision)) {
    add(errors, 'baseRevision', '必须是非空字符串')
  }
  if (!isObject(data.payload)) {
    add(errors, 'payload', '必须是对象')
  }
  if (!Array.isArray(data.warnings) || !data.warnings.every(isText)) {
    add(errors, 'warnings', '必须是字符串数组（可为空）')
  }
  return isObject(data.payload)
}

function validateSeed(payload, errors) {
  if (!isTextArray(payload.titles, 1, 3)) add(errors, 'payload.titles', '需要 1-3 个非空书名')
  for (const key of ['genre', 'premise', 'synopsis', 'coreConflict', 'tone', 'audience']) {
    if (!isText(payload[key])) add(errors, `payload.${key}`, '必须是非空字符串')
  }
  if (isText(payload.synopsis) && payload.synopsis.length > 200) {
    add(errors, 'payload.synopsis', '简介不得超过 200 字')
  }
  if (!Array.isArray(payload.characters) || payload.characters.length < 3 || payload.characters.length > 6) {
    add(errors, 'payload.characters', '需要 3-6 个角色')
  } else {
    payload.characters.forEach((c, i) => {
      if (!isObject(c)) {
        add(errors, `payload.characters[${i}]`, '必须是对象')
        return
      }
      for (const key of ['name', 'role', 'desire', 'obstacle']) {
        if (!isText(c[key])) add(errors, `payload.characters[${i}].${key}`, '必须是非空字符串')
      }
    })
  }
  if (!isTextArray(payload.worldAnchors, 3, 5)) add(errors, 'payload.worldAnchors', '需要 3-5 条非空锚点')
  if (!isTextArray(payload.sellingPoints, 3, 5)) add(errors, 'payload.sellingPoints', '需要 3-5 条非空卖点')
}

function validateSeedAssist(payload, errors) {
  if (!isText(payload.field)) add(errors, 'payload.field', '必须是非空字符串')
  if (!isTextArray(payload.suggestions, 1, 5)) {
    add(errors, 'payload.suggestions', '需要 1-5 条非空建议')
  } else {
    payload.suggestions.forEach((s, i) => {
      if (s.length > 4000) add(errors, `payload.suggestions[${i}]`, '单条建议不得超过 4000 字')
    })
  }
  if (payload.reason != null && typeof payload.reason !== 'string') {
    add(errors, 'payload.reason', '必须是字符串')
  }
}

function validateMaster(payload, errors) {
  if (!isText(payload.masterOutline)) add(errors, 'payload.masterOutline', '必须是非空字符串')
  if (!Array.isArray(payload.volumes) || payload.volumes.length < 1 || payload.volumes.length > 8) {
    add(errors, 'payload.volumes', '需要 1-8 卷')
    return
  }
  let chapterSum = 0
  payload.volumes.forEach((vol, i) => {
    if (!isObject(vol)) {
      add(errors, `payload.volumes[${i}]`, '必须是对象')
      return
    }
    for (const key of ['title', 'summary', 'goal', 'climax', 'endingHook']) {
      if (!isText(vol[key])) add(errors, `payload.volumes[${i}].${key}`, '必须是非空字符串')
    }
    if (!isInt(vol.estimatedChapters, 1, 500)) {
      add(errors, `payload.volumes[${i}].estimatedChapters`, '必须是 1-500 的整数')
    } else {
      chapterSum += vol.estimatedChapters
    }
    if (vol.targetWordCount != null && !isInt(vol.targetWordCount, 1000)) {
      add(errors, `payload.volumes[${i}].targetWordCount`, '必须是 >=1000 的整数')
    }
  })
  if (isInt(payload.targetChapters, 1) && chapterSum !== payload.targetChapters) {
    add(errors, 'payload.volumes', `预计章数之和 ${chapterSum} 与 targetChapters ${payload.targetChapters} 不一致`)
  }
}

function validateVolumeChapters(payload, errors, writtenIds) {
  if (!isInt(payload.volumeIndex, 0)) add(errors, 'payload.volumeIndex', '必须是 >=0 的整数')
  if (!Array.isArray(payload.chapters) || payload.chapters.length === 0) {
    add(errors, 'payload.chapters', '至少需要 1 章')
    return
  }
  const titles = new Set()
  payload.chapters.forEach((ch, i) => {
    const p = `payload.chapters[${i}]`
    if (!isObject(ch)) {
      add(errors, p, '必须是对象')
      return
    }
    if (!isText(ch.title)) add(errors, `${p}.title`, '必须是非空字符串')
    else if (titles.has(ch.title)) add(errors, `${p}.title`, `同卷章名重复：${ch.title}`)
    else titles.add(ch.title)
    if (!isTextArray(ch.hooks, 1, 3)) add(errors, `${p}.hooks`, '需要 1-3 条非空 hooks')
    for (const key of ['conflict', 'turn', 'payoff']) {
      if (!isText(ch[key])) add(errors, `${p}.${key}`, '必须是非空字符串')
    }
    if (!isInt(ch.targetWordCount, 500, 20000)) add(errors, `${p}.targetWordCount`, '必须是 500-20000 的整数')
    const id = ch.id || ch.chapterId
    if (id && writtenIds.has(id)) add(errors, `${p}`, `已写章不可写入：${id}`)
  })
}

function validateChapterDetail(payload, errors, writtenIds) {
  if (!isText(payload.summary)) add(errors, 'payload.summary', '必须是非空字符串')
  if (!isTextArray(payload.hooks, 3, 6)) add(errors, 'payload.hooks', '需要 3-6 条非空 hooks')
  if (!isInt(payload.targetWordCount, 500, 20000)) add(errors, 'payload.targetWordCount', '必须是 500-20000 的整数')
  if (!Array.isArray(payload.continuityNotes) || !payload.continuityNotes.every(isText)) {
    add(errors, 'payload.continuityNotes', '必须是字符串数组（可为空）')
  }
  const id = payload.chapterId || payload.id
  if (id && writtenIds.has(id)) add(errors, 'payload.chapterId', `已写章不可细化：${id}`)
}

function validateReview(payload, errors, writtenIds) {
  if (typeof payload.score !== 'number' || payload.score < 0 || payload.score > 100) {
    add(errors, 'payload.score', '必须是 0-100 的数字')
  }
  if (!Array.isArray(payload.issues)) {
    add(errors, 'payload.issues', '必须是数组')
  } else {
    payload.issues.forEach((issue, i) => {
      const p = `payload.issues[${i}]`
      if (!isObject(issue)) {
        add(errors, p, '必须是对象')
        return
      }
      for (const key of ['id', 'title', 'description', 'suggestion']) {
        if (!isText(issue[key])) add(errors, `${p}.${key}`, '必须是非空字符串')
      }
      if (!SEVERITIES.has(issue.severity)) add(errors, `${p}.severity`, '必须是 blocking/warning/info')
      if (!ISSUE_TYPES.has(issue.type)) add(errors, `${p}.type`, '类型不在允许范围')
      if (issue.patch != null) {
        if (!isObject(issue.patch)) add(errors, `${p}.patch`, '必须是对象')
        else {
          if (issue.patch.summary != null && !isText(issue.patch.summary)) add(errors, `${p}.patch.summary`, '必须是非空字符串')
          if (issue.patch.hooks != null && !isTextArray(issue.patch.hooks, 1)) add(errors, `${p}.patch.hooks`, '必须是非空字符串数组')
        }
      }
      if (issue.chapterId && writtenIds.has(issue.chapterId)) {
        add(errors, p, `已写章不可生成补丁：${issue.chapterId}`)
      }
    })
  }
  if (!isText(payload.summary)) add(errors, 'payload.summary', '必须是非空字符串')
}

function validateCalibrate(payload, errors, writtenIds) {
  if (!Array.isArray(payload.diffs)) {
    add(errors, 'payload.diffs', '必须是数组')
    return
  }
  payload.diffs.forEach((diff, i) => {
    const p = `payload.diffs[${i}]`
    if (!isObject(diff)) {
      add(errors, p, '必须是对象')
      return
    }
    if (!isText(diff.chapterId)) add(errors, `${p}.chapterId`, '必须是非空字符串')
    else if (writtenIds.has(diff.chapterId)) add(errors, p, `已写章不可重订：${diff.chapterId}`)
    if (!isTextArray(diff.oldHooks, 0)) add(errors, `${p}.oldHooks`, '必须是字符串数组')
    if (!isTextArray(diff.newHooks, 1)) add(errors, `${p}.newHooks`, '至少需要 1 条新钩子')
    if (diff.rippleEffects != null && !isTextArray(diff.rippleEffects, 0)) {
      add(errors, `${p}.rippleEffects`, '必须是字符串数组')
    }
  })
}

function validateImportOutline(payload, errors) {
  if (!isText(payload.masterOutline)) add(errors, 'payload.masterOutline', '必须是非空字符串')
  if (!Array.isArray(payload.volumes) || payload.volumes.length === 0) {
    add(errors, 'payload.volumes', '至少需要 1 卷')
    return
  }
  payload.volumes.forEach((vol, i) => {
    const p = `payload.volumes[${i}]`
    if (!isObject(vol)) {
      add(errors, p, '必须是对象')
      return
    }
    if (!isText(vol.title)) add(errors, `${p}.title`, '必须是非空字符串')
    if (!isText(vol.summary)) add(errors, `${p}.summary`, '必须是非空字符串')
    if (!Array.isArray(vol.chapters) || vol.chapters.length === 0) {
      add(errors, `${p}.chapters`, '至少需要 1 章')
      return
    }
    vol.chapters.forEach((ch, j) => {
      const cp = `${p}.chapters[${j}]`
      if (!isObject(ch)) {
        add(errors, cp, '必须是对象')
        return
      }
      if (!isText(ch.title)) add(errors, `${cp}.title`, '必须是非空字符串')
      if (ch.hooks != null && !isTextArray(ch.hooks, 0)) add(errors, `${cp}.hooks`, '必须是字符串数组')
    })
  })
}

function main() {
  const args = parseArgs(process.argv)
  const stage = args.stage
  const file = args.file
  if (!stage || !STAGES.has(stage)) {
    console.error('用法：node scripts/validate-proposal.js --stage=<stage> --file=<json>')
    process.exit(2)
  }
  if (!file) {
    console.error('缺少 --file=<json>')
    process.exit(2)
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`读取或解析失败：${err.message}`)
    process.exit(2)
  }

  const errors = []
  const writtenIds = new Set(
    String(args['written-ids'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  const hasPayload = validateEnvelope(data, stage, errors)
  if (hasPayload) {
    const payload = data.payload
    if (stage === 'seed') validateSeed(payload, errors)
    else if (stage === 'seed-assist') validateSeedAssist(payload, errors)
    else if (stage === 'master') validateMaster(payload, errors)
    else if (stage === 'volume-chapters') validateVolumeChapters(payload, errors, writtenIds)
    else if (stage === 'chapter-detail') validateChapterDetail(payload, errors, writtenIds)
    else if (stage === 'review') validateReview(payload, errors, writtenIds)
    else if (stage === 'calibrate') validateCalibrate(payload, errors, writtenIds)
    else if (stage === 'import-outline') validateImportOutline(payload, errors)
  }

  const result = { ok: errors.length === 0, stage, errors }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main()
