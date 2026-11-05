import type {
  AgentConfig,
  PipelineStage,
  QualityGate,
  BuildContextOptions,
  AgentMode,
  AgentLoopEvent,
} from '@shared/types'
import { streamChat, supportsTools, type StreamChunk } from './llm-service'
import { loadSkillForAgent, getSkillMd, getSkillFile } from './skill-service'
import { assembleContext, buildContextStringFromBundle, trimHistoryForPlan } from './context-assembler'
import { getWritingTools } from './tool-service'
import { runAgentLoop } from './agent-loop'
import { knowledgeService, type NovelSummaryJSON, type ChapterBriefJSON } from './knowledge-service'
import { evaluatePipelineGate } from './pipeline-gate'
import { blockingFindings, checkOutputContinuity, findingSummary } from './story-check-service'
import type { ContinuityFinding } from './continuity-checker'
import { ActionLog } from './log-service'
import { WRITING_CONSTRAINT } from '@shared/writing-constraint'

// 全局基础 system prompt（写作生成的底层提示词，经主进程技能保险库注入）
const basePrompt = getSkillFile('unrestricted/UNRESTRICTED.md') ?? ''
// 安全/约束层（在基础提示词之后注入）
const sandboxPrompt = getSkillFile('unrestricted/SANDBOX.md') ?? ''
// 合规基准层（写作合规要求，在安全/约束层之后注入）
const benchmarkPrompt = getSkillFile('unrestricted/UNRESTRICTEDPROMPTCOMPLIANCEBENCHMARK.md') ?? ''
// IMP-02：AI 味禁用词/句式速查
const bannedWordsRaw = getSkillFile('story-long-write/references/banned-words.md') ?? ''
// 风格锚点：人工稿真实片段 few-shot（修复生成稿「过于正式、没有感情」——
// 禁止类规则只能压坏习惯，模型还需要看到目标文风长什么样）
const styleSamplesRaw = getSkillFile('story-agent-write/style-samples.md') ?? ''

/**
 * 只注入「最毒禁用句式 + 一级禁用词」。
 * 二级（语境敏感词/弱化副词）不注入——它们需要语境判断，硬注入会误杀自然表达。
 *
 * 背景：此前 references/*.md 从未被运行时读取（loadSkillReference 无人调用），
 * 规范只存在于 SKILL.md 的文字点名里，模型实际上看不到词表。
 */
const BANNED_WORDS_BRIEF = bannedWordsRaw.split('## 二级禁用词')[0].trim()

// deslop 强制 Gate 的技能引用（正文产出后必须去AI味）
const DESLOP_GATE_SKILL = 'story-deslop'

/**
 * 按角色选取 Agent 配置（D-T4-2）。
 * 种子行（无 key）与用户配置行并存时，「取第一个匹配」的选法会命中空 key 行导致 LLM 调用必然失败；
 * 这里优先取已配置密钥的行；并列时保持传入顺序（agent_configs 无 ORDER BY 查询按 rowid 序，
 * 即插入序）取第一个，保证选择稳定；全部无 key 时回退列表第一行。
 */
export function pickAgentForRole(agents: AgentConfig[], role: string): AgentConfig | undefined {
  const rows = agents.filter((a) => a.role === role)
  return rows.find((a) => !!a.apiKeyEncrypted) ?? rows[0]
}

// 构建 agent 的 system prompt：基础设定 + 完整资料上下文 + 技能指令 + 硬约束
function buildSystemPrompt(
  agent: AgentConfig,
  contextStr: string,
  userMessage: string,
  mode?: 'chat' | 'craft',
  agentMode?: AgentMode,
  hasStyleContext = false,
  skillPromptOverride?: string,
): string {
  const skillParts: string[] = []

  // 规划工作台显式覆盖：只注入调用方拼好的技能步骤+参考+契约，不走触发词自动匹配
  const skillStr =
    skillPromptOverride !== undefined
      ? skillPromptOverride
      : loadSkillForAgent(agent.skillRefs || [], userMessage)
  if (skillStr) skillParts.push(skillStr)

  // 写作模式：强制注入"长写/agent 写作"流程指令（修复 G4：让 AI 真的按流程写作）
  if (agentMode === 'writing') {
    const writeMd = getSkillMd('story-agent-write') || getSkillMd('story-long-write')
    if (writeMd) skillParts.push(`## 写作流程指令（必须严格遵循）\n${writeMd}`)

    // 风格锚点（few-shot）：人工稿真实片段，教模型"活气"长什么样；置于禁用词表之前
    // 已绑定文风配方时由融合提示词接管，避免双重风格指令互相稀释
    if (styleSamplesRaw.trim() && !hasStyleContext) skillParts.push(styleSamplesRaw.trim())

    // IMP-02：把禁用词表真正送进 prompt（此前只在 SKILL.md 里被"点名"，模型看不到）
    if (BANNED_WORDS_BRIEF) {
      skillParts.push(
        `## 禁用词与禁用句式速查（出现即替换）\n` +
          `（若与上方"文风硬约束"冲突，以文风硬约束为准）\n\n${BANNED_WORDS_BRIEF}`
      )
    }
  }

  const sections = [
    // 8.5-1：写作模式剥离全局层末句 "Keep responses compact and direct."——
    // 终验实证该句位于 system prompt 最前部会压低章节字数（同 hooks ch1 1466 vs 2342 字）。
    // 仅写作模式剥离；chat 等其他模式保留简洁回复的原有意图。
    agentMode === 'writing'
      ? basePrompt.replace(/Keep responses compact and direct\.?\s*/i, '').trimEnd()
      : basePrompt,
    sandboxPrompt, // 安全/约束层
    benchmarkPrompt, // 合规基准层
    agent.systemPrompt,
    contextStr ? `# 小说资料（撰写前必读，严禁偏离）\n${contextStr}` : '',
    ...skillParts,
  ].filter(Boolean)

  // craft 模式：追加结构化编辑输出指令
  if (mode === 'craft') {
    sections.push(
      `[Craft 模式指令] 你需要直接修改原文。请以 JSON 数组格式返回你的所有修改建议，每条包含：\n` +
        `- "original": 原文中的确切文本（必须与原文完全一致，用于定位替换）\n` +
        `- "replacement": 替换后的新文本\n` +
        `- "reason": 简短说明修改原因\n\n` +
        `要求：\n` +
        `1. original 必须是当前章节内容中存在的精确子串（用于字符串替换）\n` +
        `2. 每条建议应聚焦一个具体问题（用词、节奏、描写、对话等）\n` +
        `3. 只返回 JSON 数组，不要包裹在 markdown 代码块之外的其他文字中\n` +
        `4. 如果用户要求的是分析而非修改，可以正常回复而不返回 JSON`,
    )
  }

  // 写作/导演模式（或存在小说上下文时）注入硬约束（修复 G7）
  const injectConstraint =
    agentMode === 'writing' || agentMode === 'director' || (agentMode === undefined && !!contextStr)
  if (injectConstraint) {
    sections.push(WRITING_CONSTRAINT)
  }

  return sections.join('\n\n')
}

// Single agent chat — yields StreamChunk objects (content + optional usage / toolEvent)
export async function* agentChat(
  agent: AgentConfig,
  userMessage: string,
  options: BuildContextOptions,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // 装配完整写作上下文（文档 M1 核心）
  const context = await assembleContext(options)
  const contextStr = buildContextStringFromBundle(context)
  const systemPrompt = buildSystemPrompt(
    agent,
    contextStr,
    userMessage,
    options.mode,
    options.agentMode,
    !!context.styleContext,
    options.skillPromptOverride,
  )

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...trimHistoryForPlan(options.previousMessages, context.contextPlan),
    { role: 'user' as const, content: userMessage },
  ]

  // 记录 AI 调用指令（操作指令）
  const logTag = `${agent.name || agent.id}${options.mode ? `/${options.mode}` : ''}`
  ActionLog.agent(`开始 ${logTag}`, { user: userMessage.slice(0, 300), tools: options.enableTools ? 'on' : 'off' })

  // 启用工具循环（Agent 能力，文档 M2）：主动检索资料 / 提交追踪
  const useAgentLoop = !!options.enableTools && supportsTools(agent)
  if (useAgentLoop) {
    yield* runAgentLoop({
      agent,
      messages,
      tools: getWritingTools(context.novelId, options.chapter?.id ?? options.chapterId),
      onEvent: options.onToolEvent,
      signal,
      maxIterations: options.maxIterations ?? 60,
    })
    return
  }

  // 知识库自动落库辅助：累加流式产出
  let fullOutput = ''

  for await (const chunk of streamChat(agent, messages, signal)) {
    if (!chunk.done && chunk.content) {
      fullOutput += chunk.content
      yield chunk
    }
    if (chunk.done) {
      if (!fullOutput.trim()) {
        // 空正文守卫（同 agent-loop）：思考型模型耗尽 max_tokens → 空气泡，需给出可行动提示
        const hint =
          chunk.finishReason === 'length'
            ? '模型把 max_tokens 全部用于内部思考，未产出正文。建议调大该 Agent 的 max_tokens，或更换模型（如 deepseek-chat）。'
            : '模型返回了空正文，请重试；若持续出现请更换模型。'
        yield { content: `\n[空回复] ${hint}`, done: true }
      } else {
        // Pass through final usage chunk even if done
        yield { content: '', done: true, usage: chunk.usage }
      }
    }
  }

  // 知识库自动落库：检测技能产出并解析 JSON 写入 KB（非工具模式下生效）
  if (!useAgentLoop && context.novelId && fullOutput) {
    await tryApplyKnowledgeBase(agent, userMessage, fullOutput, context.novelId, options.chapter?.id ?? options.chapterId)
  }
}

// Pipeline execution progress（P0 扩展 quality 门禁状态）
export interface PipelineProgress {
  stageIndex: number
  stageLabel: string
  status: 'running' | 'completed' | 'error' | 'pending-approval'
  output?: string
  error?: string
  quality?: QualityGate
  gateLabel?: string
  approvalRequest?: { reason: string }
  /** P1：连贯性门禁的确定性发现（blocking 已拦截，warning 仅提示） */
  continuityFindings?: ContinuityFinding[]
}

// P0：在流水线的正文体生成阶段后插入 deslop 强制 Gate
async function* runGate(
  stage: { agent: AgentConfig; label: string },
  output: string,
  stageIndex: number,
  skillRefs: string[],
  options: BuildContextOptions,
  signal?: AbortSignal,
): AsyncGenerator<PipelineProgress, QualityGate> {
  yield {
    stageIndex,
    stageLabel: stage.label,
    status: 'running',
    gateLabel: '质量门禁（去AI味）',
  }
  // 用 polisher agent + deslop 技能对正文执行去AI味 Gate
  const polisherAgent: AgentConfig = {
    ...stage.agent,
    role: 'polisher',
    skillRefs,
    systemPrompt: '你是质量门禁执行者，必须严格按去AI味流程清除正文中的AI写作痕迹，并产出门禁报告。',
  }
  const gatePrompt = `## 质量门禁任务\n\n请对以下正文执行去AI味（${DESLOP_GATE_SKILL}）流程：扫描 AI 味、分级、逐项清除、确定性收尾，并产出「质量门禁通过」报告。\n\n==== 待审正文 ====\n${output.slice(0, 6000)}`
  // 注意：不传 mode:'craft'——craft 会注入「返回 JSON 修改建议」指令，与门禁要求的
  // 「deslop 报告 + 全文」协议冲突；门禁只评判不回写，产出仅供展示。
  let gateOutput = ''
  for await (const chunk of agentChat(polisherAgent, gatePrompt, { ...options, mode: undefined, excludeStyle: true }, signal)) {
    gateOutput += chunk.content
  }
  const quality = await evaluatePipelineGate(output)
  yield {
    stageIndex,
    stageLabel: stage.label,
    status: quality.passed ? 'completed' : 'pending-approval',
    gateLabel: '质量门禁（去AI味）',
    output: gateOutput,
    quality,
  }
  return quality
}

export async function* runPipeline(
  stages: { agent: AgentConfig; label: string; gateSkills?: string[]; autoApprove?: boolean }[],
  userInput: string,
  options: BuildContextOptions,
  signal?: AbortSignal,
): AsyncGenerator<PipelineProgress> {
  let previousOutput = ''
  const chatHistory: { role: string; content: string }[] = [...options.previousMessages]

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]

    // Yield progress
    yield { stageIndex: i, stageLabel: stage.label, status: 'running' }

    // architect 前置于 writer 时（2026-10-05 大纲系统落实）：架构阶段的任务不是写正文，
    // 而是产出本章细化写作细纲（分场景要点/事实锚点/衔接要求），供 writer 按纲写作
    const isFirstStageArchitect =
      i === 0 && stage.agent.role === 'architect' && stages.some((s, j) => j > i && s.agent.role === 'writer')
    const stagePrompt = i === 0
      ? isFirstStageArchitect
        ? `${userInput}\n\n（架构阶段任务：不要写正文。请基于上述创作任务与细纲锚点，产出本章细化写作细纲——分场景要点、必须命中的事实锚点、与上一章的衔接要求。后续 writer 将严格按你的细纲写正文。）`
        : userInput
      : `${userInput}\n\n上一阶段产出：\n${previousOutput.slice(0, 4000)}\n\n请基于以上内容进入当前阶段处理。`

    chatHistory.push({ role: 'user', content: stagePrompt })

    let output = ''
    const updatedOptions: BuildContextOptions = { ...options, previousMessages: chatHistory }
    // writer 阶段强制 writing 模式：加载 story-agent-write SKILL、风格锚点与禁用词表
    // （此前流水线未设 agentMode，整套文风体系在流水线路径被整体绕过）
    const stageOptions: BuildContextOptions = {
      ...updatedOptions,
      agentMode: stage.agent.role === 'writer' ? 'writing' : updatedOptions.agentMode,
    }

    // P0 修复：chunk 为 StreamChunk 对象，必须取 .content 拼接
    for await (const chunk of agentChat(stage.agent, stagePrompt, stageOptions, signal)) {
      output += chunk.content
    }

    chatHistory.push({ role: 'assistant', content: output })
    previousOutput = output

    // P1：连贯性门禁——writer 产出先过确定性规则，硬伤默认拦截下发
    if (stage.agent.role === 'writer') {
      const mode = updatedOptions.continuityGate ?? 'blocking'
      if (mode !== 'off') {
        try {
          const findings = await checkOutputContinuity({
            novelId: updatedOptions.novelId ?? '',
            chapter: updatedOptions.chapter,
            chapterId: updatedOptions.chapterId,
            chapterOrder: updatedOptions.chapterOrder,
            hooks: updatedOptions.chapterHooks,
            content: output,
          })
          const blocking = blockingFindings(findings)
          if (blocking.length) {
            ActionLog.agent('连贯性门禁', {
              stage: stage.label,
              blocking: blocking.length,
              warnings: findings.length - blocking.length,
              summary: findingSummary(blocking),
            })
            if (mode === 'blocking') {
              yield {
                stageIndex: i,
                stageLabel: stage.label,
                status: 'pending-approval',
                gateLabel: `连贯性检查未通过（${blocking.length}处硬伤），已拦截下发`,
                output,
                continuityFindings: findings,
              }
              return
            }
          }
        } catch (e) {
          // 检查器不可用时不阻断流水线（例如旧库尚未迁移完成）
          console.warn('[pipeline] continuity gate skipped:', e)
        }
      }
    }

    // P0：正文产出后强制质量门禁 Gate（未通过不下发下一阶段）
    const gateSkills = stage.gateSkills ?? (stage.agent.role === 'writer' ? [DESLOP_GATE_SKILL] : undefined)
    if (gateSkills && gateSkills.length) {
      const gate = yield* runGate(stage, output, i, gateSkills, updatedOptions, signal)
      // 未通过门禁：中断流水线，标记拦截（复用门禁结果，不重复评分）
      if (!gate.passed) {
        yield {
          stageIndex: i,
          stageLabel: stage.label,
          status: 'pending-approval',
          gateLabel: '质量门禁未通过，已拦截下发',
          output,
          quality: gate,
        }
        return
      }
    }

    yield { stageIndex: i, stageLabel: stage.label, status: 'completed', output }

    // P2：审批节点（Human-in-the-Loop）—— 关键节点需作者批准/接管后才下发
    if (stage.autoApprove === false) {
      yield {
        stageIndex: i,
        stageLabel: stage.label,
        status: 'pending-approval',
        gateLabel: '关键节点待审批',
        output,
        approvalRequest: { reason: '关键节点（大纲定稿/黄金三章/卷末）需作者审批后继续' },
      }
      return
    }
  }
}

// ===== 知识库自动落库 =====

/**
 * 检测 agent 产出是否包含 story-summarize / story-chapter-summary / story-arc-design 的 JSON/文本产出，
 * 若是则解析并写入知识库。落库失败不阻断主流程。
 */
async function tryApplyKnowledgeBase(
  agent: AgentConfig,
  userMessage: string,
  fullOutput: string,
  novelId: string,
  chapterId?: string,
): Promise<void> {
  try {
    const lowerUser = userMessage.toLowerCase()
    const skillRefs = agent.skillRefs || []

    // story-summarize：全书总结 → JSON → novel.md + volumes/*.md
    if (skillRefs.includes('story-summarize') ||
        /全书总结|整书概要|作品备忘录|回顾全书|summarize/.test(lowerUser)) {
      const json = extractJson(fullOutput)
      if (json) {
        const summary: NovelSummaryJSON = JSON.parse(json)
        await knowledgeService.applyNovelSummary(novelId, summary)
        console.log('[kb] applied novel summary from agent output')
        return
      }
    }

    // story-chapter-summary：章节总结 → JSON → chapters/<chId>.md
    if (skillRefs.includes('story-chapter-summary') ||
        /章结|章节总结|本章概要|章节纪要|总结章|summary/.test(lowerUser)) {
      const json = extractJson(fullOutput)
      if (json && chapterId) {
        const brief: ChapterBriefJSON = JSON.parse(json)
        await knowledgeService.applyChapterBrief(novelId, chapterId, brief)
        console.log('[kb] applied chapter brief from agent output')
        return
      }
    }

    // story-arc-design：弧光设计 → 节拍表文本 → arc.md
    if (skillRefs.includes('story-arc-design') ||
        /弧光|arc|人物弧|剧情弧|成长线|情感曲线|弧线设计/.test(lowerUser)) {
      // 节拍表是纯文本，直接写入
      if (fullOutput.trim().length > 20) {
        await knowledgeService.applyArcDesign(novelId, fullOutput.trim())
        console.log('[kb] applied arc design from agent output')
        return
      }
    }
  } catch (e) {
    console.warn('[kb] tryApplyKnowledgeBase failed:', e)
  }
}

/** 从可能含包裹文本的输出中提取首个 JSON 对象。 */
function extractJson(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1)
  }
  return null
}
