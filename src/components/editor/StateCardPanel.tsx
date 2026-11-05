import { useState, useEffect, useCallback } from 'react'
import { Loader2, Save, RefreshCw, AlertTriangle, Check, ClipboardList } from 'lucide-react'
import { novelService } from '@/services/data-service'
import {
  commitTrackingState,
  loadTrackingState,
  type TrackingState,
} from '@/services/tracking-service'
import { cn } from '@/utils/cn'

function lines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean)
}

function joinLines(items: string[]): string {
  return items.join('\n')
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/20 bg-muted/5 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-foreground/80">{title}</span>
        {hint && <span className="text-[9px] text-muted-foreground/60">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

const LIST_CLS =
  'w-full rounded-md bg-muted/30 border border-border/50 px-2 py-1.5 text-[11px] leading-relaxed ' +
  'text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y'

export default function StateCardPanel({ novelId }: { novelId: string }) {
  const [state, setState] = useState<TrackingState | null>(null)
  const [novelTitle, setNovelTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [conflict, setConflict] = useState<{ currentRevision: number; state: TrackingState } | null>(null)
  const [overrideArmed, setOverrideArmed] = useState(false)
  const [constraints, setConstraints] = useState('')
  const [risks, setRisks] = useState('')
  const [promises, setPromises] = useState('')

  const applyState = useCallback((next: TrackingState) => {
    setState(next)
    setConstraints(joinLines(next.longTermConstraints))
    setRisks(joinLines(next.coherenceRisks))
    setPromises(joinLines(next.nextChapterPromises))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    setConflict(null)
    setOverrideArmed(false)
    try {
      const next = await loadTrackingState(novelId)
      applyState(next)
      const novel = await novelService.getById(novelId)
      setNovelTitle(novel?.title ?? '')
    } catch (e) {
      setMsg({ kind: 'err', text: `读取状态卡失败：${(e as Error).message}` })
    } finally {
      setLoading(false)
    }
  }, [novelId, applyState])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  if (!state) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <ClipboardList size={26} className="text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground/60">状态卡读取失败</p>
        <button onClick={() => void load()} className="mt-2 text-xs text-primary hover:underline">
          重新加载
        </button>
      </div>
    )
  }

  const dirty =
    joinLines(lines(constraints)) !== joinLines(state.longTermConstraints) ||
    joinLines(lines(risks)) !== joinLines(state.coherenceRisks) ||
    joinLines(lines(promises)) !== joinLines(state.nextChapterPromises)

  const patch = () => ({
    longTermConstraints: lines(constraints),
    coherenceRisks: lines(risks),
    nextChapterPromises: lines(promises),
  })

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setMsg(null)
    try {
      const res = await commitTrackingState(novelId, patch(), {
        expectedRevision: state.revision,
        source: 'manual',
      })
      if (!res.ok) {
        setConflict({ currentRevision: res.currentRevision, state: res.state })
        setOverrideArmed(false)
        setMsg({ kind: 'warn', text: '状态已在别处更新，本次提交未写入。' })
        return
      }
      applyState(res.state)
      setConflict(null)
      setMsg({ kind: 'ok', text: `已保存，状态版本 v${res.state.revision}` })
    } catch (e) {
      setMsg({ kind: 'err', text: `保存失败：${(e as Error).message}` })
    } finally {
      setSaving(false)
    }
  }

  const handleOverride = async () => {
    if (!conflict || saving) return
    if (!overrideArmed) {
      setOverrideArmed(true)
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const res = await commitTrackingState(novelId, patch(), {
        expectedRevision: conflict.currentRevision,
        source: 'manual',
      })
      if (!res.ok) {
        setConflict({ currentRevision: res.currentRevision, state: res.state })
        setOverrideArmed(false)
        setMsg({ kind: 'warn', text: '保存期间状态又更新了，请再次确认。' })
        return
      }
      applyState(res.state)
      setConflict(null)
      setOverrideArmed(false)
      setMsg({ kind: 'ok', text: `已覆盖保存，状态版本 v${res.state.revision}` })
    } catch (e) {
      setMsg({ kind: 'err', text: `覆盖保存失败：${(e as Error).message}` })
    } finally {
      setSaving(false)
    }
  }

  const activeForeshadowings = state.activeForeshadowings.filter((f) => f.status === 'planted')
  const characters = Object.entries(state.characterInvolvements)
  const sizeKb = new TextEncoder().encode(JSON.stringify(state)).length / 1024
  const lastTx = state.transactions?.[state.transactions.length - 1]

  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground truncate">
          {novelTitle ? `《${novelTitle}》` : ''} 状态版本 v{state.revision}
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground/60 tabular-nums">
          {sizeKb.toFixed(1)}KB
        </span>
        <button
          onClick={() => void load()}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          title="重新加载状态"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {msg && (
        <div
          className={cn(
            'mx-3 mt-2 px-2.5 py-1.5 rounded text-[11px] leading-relaxed',
            msg.kind === 'ok'
              ? 'bg-green-500/10 text-green-400'
              : msg.kind === 'warn'
                ? 'bg-amber-500/10 text-amber-400'
                : 'bg-red-500/10 text-red-400',
          )}
        >
          {msg.text}
        </div>
      )}

      {conflict && (
        <div className="mx-3 mt-2 px-2.5 py-2 rounded bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400">
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1 leading-relaxed">
              状态已在别处更新至 v{conflict.currentRevision}，当前编辑基于 v{state.revision}。
              重新加载会丢弃本地修改；覆盖会以本页内容为准。
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 pl-4">
            <button
              onClick={() => void load()}
              className="px-2 py-0.5 rounded bg-muted/40 hover:bg-muted/60 text-[10px] transition-colors"
            >
              重新加载
            </button>
            <button
              onClick={() => void handleOverride()}
              disabled={saving}
              className={cn(
                'px-2 py-0.5 rounded text-[10px] transition-colors disabled:opacity-40',
                overrideArmed
                  ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                  : 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30',
              )}
            >
              {overrideArmed ? '确认覆盖并保存？' : '覆盖保存'}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2.5 py-2 space-y-2">
        <Section title="当前位置">
          <div className="text-[11px] text-foreground/80">
            第 {state.currentPosition.volume} 卷 · 第 {state.currentPosition.chapter} 章
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            已收录 {state.committedChapters.length} 章 · 共 {state.totalWordCount.toLocaleString()} 字
          </div>
        </Section>

        <Section title="长期约束" hint="每行一条，最多 6 条">
          <textarea
            rows={3}
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            placeholder="永久生效的设定裁定，如：主角不能主动杀人"
            className={LIST_CLS}
          />
          {lines(constraints).length > 6 && (
            <div className="mt-1 text-[9px] text-amber-400">保存时只保留前 6 条</div>
          )}
        </Section>

        <Section title="核心角色状态" hint="只读">
          {characters.length === 0 ? (
            <div className="text-[10px] text-muted-foreground/60">完成章节后自动生成</div>
          ) : (
            <div className="space-y-0.5">
              {characters.map(([name, titles]) => (
                <div key={name} className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-foreground/80">{name}</span>
                  <span className="text-[9px] text-muted-foreground">出场 {titles.length} 章</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="活跃伏笔" hint={`${activeForeshadowings.length} 条未回收`}>
          {activeForeshadowings.length === 0 ? (
            <div className="text-[10px] text-muted-foreground/60">暂无活跃伏笔</div>
          ) : (
            <div className="space-y-0.5">
              {activeForeshadowings.slice(0, 8).map((f) => (
                <div key={f.id} className="text-[11px] text-foreground/80 leading-relaxed">
                  <span className="text-[9px] text-muted-foreground mr-1">第{f.plantedChapter}章</span>
                  {f.content}
                </div>
              ))}
              {activeForeshadowings.length > 8 && (
                <div className="text-[9px] text-muted-foreground/60">
                  还有 {activeForeshadowings.length - 8} 条，去伏笔面板查看
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="近三章速记" hint="只读">
          {state.recentChapters.length === 0 ? (
            <div className="text-[10px] text-muted-foreground/60">还没有完成章节</div>
          ) : (
            <div className="space-y-1">
              {state.recentChapters.map((r, i) => (
                <div key={`${r.chapter}-${i}`} className="text-[11px] leading-relaxed">
                  <span className="text-muted-foreground">第{r.chapter}章 {r.title}</span>
                  {r.summary && <div className="text-foreground/70">{r.summary}</div>}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="下一章承诺" hint="本章结尾必须兑现的钩子">
          <textarea
            rows={3}
            value={promises}
            onChange={(e) => setPromises(e.target.value)}
            placeholder="每行一条，如：下一章必须揭示黑衣人身份"
            className={LIST_CLS}
          />
        </Section>

        <Section title="连贯性风险" hint="未解决的连续性隐患">
          <textarea
            rows={3}
            value={risks}
            onChange={(e) => setRisks(e.target.value)}
            placeholder="每行一条，如：主角的伤在第 5 章后未再提及"
            className={LIST_CLS}
          />
        </Section>

        {lastTx && (
          <div className="text-[9px] text-muted-foreground/50 px-1">
            最近事务：{lastTx.source} · v{lastTx.expectedRevision} → v{lastTx.revision}
            {lastTx.changed.length ? ` · ${lastTx.changed.join(' / ')}` : ''}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-border/20 flex items-center gap-2">
        <span className={cn('text-[10px]', dirty ? 'text-amber-400' : 'text-muted-foreground/60')}>
          {dirty ? '有未保存修改' : '已同步'}
        </span>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className={cn(
            'ml-auto flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : dirty ? <Save size={11} /> : <Check size={11} />}
          {saving ? '保存中…' : '保存状态'}
        </button>
      </div>
    </>
  )
}
