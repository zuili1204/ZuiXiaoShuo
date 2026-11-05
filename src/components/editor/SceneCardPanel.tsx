import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Loader2,
  Check,
  AlertTriangle,
  ListTree,
} from 'lucide-react'
import { useWorkbenchStore, useSettingsStore } from '@/stores'
import {
  listSceneCards,
  createSceneCard,
  updateSceneCard,
  deleteSceneCard,
  ensureSceneCardsForChapter,
  computeHooksCoverage,
  type SceneCardPatch,
} from '@/services/scene-service'
import { agentChat, pickAgentForRole } from '@/services/agent-service'
import {
  extractSceneContent,
  hasSceneMarkers,
  insertSceneMarkersAtParagraphs,
  removeSceneMarker,
  replaceSceneContent,
  sceneMarker,
  stripSceneMarkers,
} from '@shared/scene-marker'
import { cn } from '@/utils/cn'
import type { SceneCard, SceneCardStatus } from '@shared/types'

const STATUS_LABEL: Record<SceneCardStatus, string> = {
  planned: '待写',
  writing: '写作中',
  written: '已写',
  cut: '已废弃',
}

const STATUS_STYLE: Record<SceneCardStatus, string> = {
  planned: 'bg-muted/40 text-muted-foreground',
  writing: 'bg-blue-500/15 text-blue-400',
  written: 'bg-green-500/15 text-green-400',
  cut: 'bg-red-500/15 text-red-400 line-through',
}

function splitList(raw: string): string[] {
  return raw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
}

/** 施工图字段：失焦保存，避免逐键写库 */
function EditField({
  label,
  value,
  onSave,
  multiline,
  placeholder,
}: {
  label: string
  value: string
  onSave: (value: string) => void
  multiline?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onSave(draft)
  }
  const cls =
    'w-full rounded-md bg-muted/30 border border-border/50 px-1.5 py-1 text-[11px] text-foreground ' +
    'focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none'
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] text-muted-foreground">{label}</span>
      {multiline ? (
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder={placeholder}
          className={cls}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder={placeholder}
          className={cls}
        />
      )}
    </label>
  )
}

export default function SceneCardPanel({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const editorContent = useWorkbenchStore((s) => s.editorContent)
  const applyEditorContent = useWorkbenchStore((s) => s.applyEditorContent)
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)

  const [cards, setCards] = useState<SceneCard[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const chapterId = selectedChapter?.id ?? null
  const hooks = selectedChapter?.hooks ?? []
  const coverage = computeHooksCoverage(cards, hooks)
  const markersMissing = !!editorContent.trim() && cards.length > 0 && !hasSceneMarkers(editorContent)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setMsg(null)
      setBusyId(null)
      if (!selectedChapter) {
        setCards([])
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const existing = await listSceneCards(selectedChapter.id)
        const list = existing.length
          ? existing
          : await ensureSceneCardsForChapter(novelId, selectedChapter)
        if (!cancelled) setCards(list)
      } catch (e) {
        if (!cancelled) setMsg(`读取场景卡失败：${(e as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [chapterId, novelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const patchCard = useCallback((id: string, patch: SceneCardPatch) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    updateSceneCard(id, patch).catch((e) => setMsg(`保存场景卡失败：${(e as Error).message}`))
  }, [])

  const handleAdd = async () => {
    if (!selectedChapter) return
    try {
      const card = await createSceneCard({
        novelId,
        chapterId: selectedChapter.id,
        orderNum: cards.length + 1,
        title: `第${cards.length + 1}场`,
      })
      setCards((prev) => [...prev, card])
      setExpandedId(card.id)
      setMsg('已新增场景卡，补全目标后可逐场生成')
    } catch (e) {
      setMsg(`新增场景失败：${(e as Error).message}`)
    }
  }

  const handleDelete = async (card: SceneCard) => {
    const body = extractSceneContent(editorContent, card.id)?.trim()
    const tip = body
      ? `删除「${card.title}」？正文内容会保留，只移除场景卡与边界标记。`
      : `删除「${card.title}」？`
    if (!window.confirm(tip)) return
    try {
      await deleteSceneCard(card.id)
      setCards((prev) => prev.filter((c) => c.id !== card.id))
      const next = removeSceneMarker(editorContent, card.id)
      if (next !== editorContent && selectedChapter) applyEditorContent(selectedChapter.id, next)
      if (expandedId === card.id) setExpandedId(null)
    } catch (e) {
      setMsg(`删除失败：${(e as Error).message}`)
    }
  }

  const handleStatusChange = (card: SceneCard, status: SceneCardStatus) => {
    patchCard(card.id, { status })
  }

  const handleInsertMarkers = () => {
    if (!selectedChapter || !cards.length) return
    if (hasSceneMarkers(editorContent)) {
      setMsg('正文已有场景标记，无需重复插入')
      return
    }
    const next = editorContent.trim()
      ? insertSceneMarkersAtParagraphs(editorContent, cards.map((c) => c.id))
      : cards.map((c) => `${sceneMarker(c.id)}\n\n`).join('').trimEnd()
    applyEditorContent(selectedChapter.id, next)
    setMsg('已插入场景边界，之后重写只替换对应区间')
  }

  const handleGenerate = async (card: SceneCard) => {
    if (!selectedChapter) return
    const agent = pickAgentForRole(agentConfigs, 'writer')
    if (!agent?.apiKeyEncrypted) {
      setMsg('请先在设置中为「作者」配置可用的模型与密钥')
      return
    }
    setBusyId(card.id)
    setMsg(null)
    patchCard(card.id, { status: 'writing' })
    const chapter = selectedChapter
    try {
      let base = editorContent
      if (!hasSceneMarkers(base)) {
        base = base.trim()
          ? insertSceneMarkersAtParagraphs(base, cards.map((c) => c.id))
          : cards.map((c) => `${sceneMarker(c.id)}\n\n`).join('').trimEnd()
      }
      const existing = extractSceneContent(base, card.id)?.trim() ?? ''
      // 生成时排除本场旧稿，避免模型逐字复述；同章其他场景仍作为衔接依据
      const contextContent = existing ? (replaceSceneContent(base, card.id, '') ?? base) : base
      const others = cards
        .filter((c) => c.id !== card.id && c.status !== 'cut')
        .map(
          (c) =>
            `第${c.orderNum}场《${c.title}》：目标 ${c.goal || '未填'}；转折 ${c.turn || '未填'}；结果 ${c.outcome || '未填'}`,
        )
        .join('\n')
      const prompt = [
        `你是小说作者。请只输出本章「第${card.orderNum}场」的正文，不要输出标题、场景标记、解释或任何前后缀。`,
        '',
        `【章节】第${chapter.order}章《${chapter.title}》`,
        chapter.hooks.length ? `【本章细纲】${chapter.hooks.join(' / ')}` : '',
        `【本场施工图】`,
        `场景：${card.title || `第${card.orderNum}场`}`,
        `目标：${card.goal || '未填'}`,
        `阻力：${card.obstacle || '未填'}`,
        `转折：${card.turn || '未填'}`,
        `结果/钩子：${card.outcome || '未填'}`,
        `情绪：${card.emotionBefore || '未填'} → ${card.emotionAfter || '未填'}`,
        card.location ? `地点：${card.location}` : '',
        card.storyTime ? `时间：${card.storyTime}` : '',
        card.characters.length ? `出场人物：${card.characters.join('、')}` : '',
        card.props.length ? `关键道具：${card.props.join('、')}` : '',
        others ? `【同章其他场景】\n${others}` : '',
        existing ? `【本场已有正文（请重写，保持与前后场景衔接）】\n${existing.slice(-1200)}` : '',
        '',
        '要求：',
        `1. 约 ${card.wordTarget} 字，中文书面语，重画面与动作，避免总结式叙述。`,
        '2. 必须依次完成“目标 → 阻力 → 转折 → 结果”，结尾留下指向下一场的钩子。',
        '3. 直接给正文，不要任何说明。',
      ]
        .filter(Boolean)
        .join('\n')

      let output = ''
      for await (const chunk of agentChat(agent, prompt, {
        novelId,
        chapter,
        chapterContent: contextContent,
        previousMessages: [],
        agentMode: 'writing',
      })) {
        if (chunk.content) output += chunk.content
      }
      const body = stripSceneMarkers(output).trim()
      if (!body) throw new Error('模型没有返回正文')
      const stillCurrent = useWorkbenchStore.getState().selectedChapter?.id === chapter.id
      // 生成期间作者可能继续编辑：优先把结果合并进最新正文，避免覆盖新改动
      const latest = useWorkbenchStore.getState().editorContent
      const applyBase =
        !stillCurrent
          ? base
          : extractSceneContent(latest, card.id) !== null
            ? latest
            : base
      const next = replaceSceneContent(applyBase, card.id, body)
      if (next == null) throw new Error('正文缺少该场景标记，请先重新插入场景标记')

      if (stillCurrent) {
        applyEditorContent(chapter.id, next)
        patchCard(card.id, { status: 'written' })
      } else {
        // 正文未写入编辑器，卡片不能显示为已写
        patchCard(card.id, { status: card.status })
      }
      setMsg(
        stillCurrent
          ? `第${card.orderNum}场已${existing ? '重写' : '生成'}，编辑器将自动保存`
          : `第${card.orderNum}场已生成，但当前章节已切换，结果未写入编辑器`,
      )
    } catch (e) {
      patchCard(card.id, { status: card.status })
      setMsg(`生成失败：${(e as Error).message}`)
    } finally {
      setBusyId(null)
    }
  }

  if (!selectedChapter) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <ListTree size={26} className="text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground/60">先选择一个章节，再拆场景卡</p>
      </div>
    )
  }

  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground truncate">
          《{selectedChapter.title}》{cards.length > 0 ? ` · ${cards.length} 场` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleInsertMarkers}
            disabled={!cards.length}
            className="px-1.5 py-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-40 transition-colors"
            title="在正文中插入场景边界标记"
          >
            插入标记
          </button>
          <button
            onClick={handleAdd}
            className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[10px] bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
          >
            <Plus size={10} />
            新增场景
          </button>
        </div>
      </div>

      {hooks.length > 0 && (
        <div className="px-3 py-1.5 border-b border-border/20 flex items-center gap-1.5 text-[10px]">
          <span className={coverage.covered === coverage.total ? 'text-green-400' : 'text-amber-400'}>
            细纲覆盖 {coverage.covered}/{coverage.total}
          </span>
          {coverage.uncovered.length > 0 && (
            <span className="text-muted-foreground truncate" title={coverage.uncovered.join('、')}>
              · 未覆盖：{coverage.uncovered.join('、')}
            </span>
          )}
        </div>
      )}

      {msg && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-muted/30 text-[11px] text-foreground leading-relaxed">
          {msg}
        </div>
      )}

      {markersMissing && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-amber-500/10 text-[10px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          <span>
            正文尚未按场景切分。逐场生成不会自动改动现有正文，可先点「插入标记」确定场景边界。
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
          </div>
        )}

        {!loading && cards.length === 0 && (
          <div className="text-center text-xs text-muted-foreground/60 py-10 leading-relaxed px-6">
            本章还没有场景卡。
            <br />
            有细纲时会按细纲逐条拆卡，也可以手动新增。
          </div>
        )}

        {!loading &&
          cards.map((card) => {
            const body = extractSceneContent(editorContent, card.id)?.trim() ?? ''
            const expanded = expandedId === card.id
            const busy = busyId === card.id
            return (
              <div
                key={card.id}
                className="mb-1 rounded-lg border border-border/20 bg-muted/5 overflow-hidden"
              >
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <button
                    onClick={() => setExpandedId(expanded ? null : card.id)}
                    className="p-0.5 text-muted-foreground hover:text-foreground"
                    title={expanded ? '收起' : '展开施工图'}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <span className="text-[10px] text-muted-foreground tabular-nums w-4">
                    {card.orderNum}
                  </span>
                  <span
                    className={cn(
                      'text-[9px] px-1.5 py-0.5 rounded flex-shrink-0',
                      STATUS_STYLE[card.status],
                    )}
                  >
                    {STATUS_LABEL[card.status]}
                  </span>
                  <span className="truncate flex-1 text-[11px] text-foreground" title={card.title}>
                    {card.title || '未命名场景'}
                  </span>
                  {body.length > 0 && (
                    <span className="text-[9px] text-muted-foreground/60 flex-shrink-0">
                      {body.length}字
                    </span>
                  )}
                  <button
                    onClick={() => handleGenerate(card)}
                    disabled={busy || !!busyId}
                    className={cn(
                      'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors disabled:opacity-40',
                      body
                        ? 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                        : 'bg-primary/15 text-primary hover:bg-primary/25',
                    )}
                    title={body ? '重写本场（不影响其他场景）' : '生成本场正文'}
                  >
                    {busy ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                    {busy ? '生成中' : body ? '重写' : '生成'}
                  </button>
                  <button
                    onClick={() => handleDelete(card)}
                    className="p-0.5 rounded text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="删除场景卡"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>

                {expanded && (
                  <div className="px-2.5 pb-2 border-t border-border/10 pt-2 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">状态</span>
                      <select
                        value={card.status}
                        onChange={(e) => handleStatusChange(card, e.target.value as SceneCardStatus)}
                        className="h-6 rounded-md bg-muted/30 border border-border/60 text-[10px] text-foreground focus:outline-none"
                      >
                        {(Object.keys(STATUS_LABEL) as SceneCardStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                      <span className="ml-auto text-[10px] text-muted-foreground">目标字数</span>
                      <input
                        type="number"
                        min={0}
                        step={100}
                        value={card.wordTarget}
                        onChange={(e) => patchCard(card.id, { wordTarget: Number(e.target.value) || 0 })}
                        className="w-16 h-6 rounded-md bg-muted/30 border border-border/60 px-1 text-[10px] text-center text-foreground focus:outline-none"
                      />
                    </div>

                    <EditField
                      label="场景标题"
                      value={card.title}
                      onSave={(v) => patchCard(card.id, { title: v })}
                    />
                    <EditField
                      label="目标（本场必须推进什么）"
                      value={card.goal}
                      onSave={(v) => patchCard(card.id, { goal: v })}
                      multiline
                    />
                    <EditField
                      label="阻力"
                      value={card.obstacle}
                      onSave={(v) => patchCard(card.id, { obstacle: v })}
                      multiline
                    />
                    <EditField
                      label="转折"
                      value={card.turn}
                      onSave={(v) => patchCard(card.id, { turn: v })}
                      multiline
                    />
                    <EditField
                      label="结果 / 钩子"
                      value={card.outcome}
                      onSave={(v) => patchCard(card.id, { outcome: v })}
                      multiline
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <EditField
                        label="起始情绪"
                        value={card.emotionBefore}
                        onSave={(v) => patchCard(card.id, { emotionBefore: v })}
                      />
                      <EditField
                        label="结束情绪"
                        value={card.emotionAfter}
                        onSave={(v) => patchCard(card.id, { emotionAfter: v })}
                      />
                      <EditField
                        label="地点"
                        value={card.location}
                        onSave={(v) => patchCard(card.id, { location: v })}
                      />
                      <EditField
                        label="故事时间"
                        value={card.storyTime}
                        onSave={(v) => patchCard(card.id, { storyTime: v })}
                      />
                    </div>
                    <EditField
                      label="出场人物（顿号分隔）"
                      value={card.characters.join('、')}
                      onSave={(v) => patchCard(card.id, { characters: splitList(v) })}
                    />
                    <EditField
                      label="关键道具（顿号分隔）"
                      value={card.props.join('、')}
                      onSave={(v) => patchCard(card.id, { props: splitList(v) })}
                    />
                    <EditField
                      label="对应细纲（顿号分隔）"
                      value={card.hooks.join('、')}
                      onSave={(v) => patchCard(card.id, { hooks: splitList(v) })}
                    />

                    {card.status === 'written' && !body && (
                      <div className="text-[10px] text-amber-400 flex items-center gap-1">
                        <AlertTriangle size={10} />
                        标记为已写，但正文中没找到这一场的内容
                      </div>
                    )}
                    {body && (
                      <div className="flex items-center gap-1 text-[10px] text-green-400/80">
                        <Check size={10} />
                        正文已包含本场内容
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
      </div>
    </>
  )
}
