// F3 题材模板服务：把模板落进一本已存在的书。
// 复用大纲向导的 applyProspectiveOutline 链路（卷/章骨架/角色/KB outline.md），
// 再补世界观条目与模板说明笔记。全程本地写入，不调 LLM。

import type { NovelTemplate } from '@/config/novel-templates'
import { applyProspectiveOutline } from './outline-planner'
import { novelService, worldviewService } from './data-service'
import { knowledgeService } from './knowledge-service'

export interface ApplyTemplateResult {
  volumes: number
  chapters: number
  characters: number
  worldviewEntries: number
}

export async function applyNovelTemplate(novelId: string, template: NovelTemplate): Promise<ApplyTemplateResult> {
  // 简介补填：只在用户没写简介时用模板示例，绝不覆盖用户自己的文字
  const novel = await novelService.getById(novelId)
  const premise = novel && !novel.description.trim() ? template.descriptionExample : ''

  // 1. 立项 + 分卷 + 前三章骨架 + 角色 + KB outline.md
  //    title 传空：模板不改用户已输入的书名
  const outlineResult = await applyProspectiveOutline(novelId, {
    confirmed: {
      title: '',
      genre: template.genres[0] ?? '',
      premise,
      characters: template.characters,
      volumeCount: template.masterPlan.volumes.length,
    },
    masterPlan: template.masterPlan,
    firstVolumeChapters: template.goldenThree,
  })

  // 2. 世界观条目：与已有条目重名的跳过，绝不覆盖
  const existing = await worldviewService.getByNovelId(novelId)
  let wvCount = 0
  for (const entry of template.worldviewEntries) {
    if (existing.some((w) => w.title === entry.title)) continue
    await worldviewService.create({
      novelId,
      category: entry.category,
      title: entry.title,
      content: entry.content,
    })
    wvCount++
  }

  // 3. KB 模板笔记：记录用了哪套模板、接下来该改什么
  const md = buildTemplateNotesMd(template, outlineResult.chapters)
  await knowledgeService.write(novelId, 'template-notes.md', md, 'template-service')

  return { ...outlineResult, worldviewEntries: wvCount }
}

function buildTemplateNotesMd(template: NovelTemplate, chapterCount: number): string {
  const lines: string[] = []
  lines.push(`# 模板笔记：${template.name}`)
  lines.push('')
  lines.push(`> 本篇基于「${template.name}」模板搭建：${template.blurb}。已生成主线分卷与 ${chapterCount} 章骨架，所有内容均可修改。`)
  lines.push('')
  lines.push('## 模板给了什么')
  lines.push('')
  lines.push(`- 主线与 ${template.masterPlan.volumes.length} 卷分卷规划（大纲管理面板可见）`)
  lines.push(`- 前 ${chapterCount} 章的章纲骨架（临写时建议用「AI 流水线」的架构步细化）`)
  lines.push(`- ${template.characters.length} 个初始角色（角色设定面板可改）`)
  lines.push(`- ${template.worldviewEntries.length} 条世界观设定（世界观面板可改）`)
  lines.push('')
  lines.push('## 建议下一步')
  lines.push('')
  lines.push('1. 把简介改成你自己的话（模板只在简介为空时补了一句示例）')
  lines.push('2. 过一遍前三章骨架，把钩子换成你的故事细节')
  lines.push('3. 在「AI 流水线」选「架构 → 写作」开始第一章')
  lines.push('')
  return lines.join('\n')
}

// ===== 用户模板（拆书产物）存取 =====

const TEMPLATE_DIR = 'content/templates'

/** 保存用户模板 JSON（拆书产物）。浏览器环境抛错由调用方兜底。 */
export async function saveUserTemplate(template: NovelTemplate): Promise<void> {
  const api = window.electronAPI?.file
  if (!api) throw new Error('当前环境不支持写入模板文件')
  await api.write(`${TEMPLATE_DIR}/${template.id}.json`, JSON.stringify(template, null, 2))
}

/** 列出用户模板（内置模板之外）。读不出来或解析失败的文件直接跳过。 */
export async function listUserTemplates(): Promise<NovelTemplate[]> {
  const api = window.electronAPI?.file
  if (!api?.list || !api?.read) return []
  let files: string[] = []
  try {
    files = await api.list(TEMPLATE_DIR)
  } catch {
    return []
  }
  const out: NovelTemplate[] = []
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await api.read(`${TEMPLATE_DIR}/${name}`)) as NovelTemplate
      if (parsed?.id && parsed?.name && Array.isArray(parsed.goldenThree)) out.push(parsed)
    } catch {
      // 损坏文件跳过
    }
  }
  return out
}
