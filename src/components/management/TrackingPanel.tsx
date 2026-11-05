import { useState, useEffect, useMemo } from 'react'
import { AlertTriangle, BookOpen, Clock, Flag, Target, GitBranch, Users, Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  createDefaultState,
  generateStateCard,
  generateCharacterSnapshots,
  generateForeshadowView,
  type TrackingState,
} from '@/services/tracking-service'
import { chapterService, characterService, foreshadowingService } from '@/services/data-service'
import { ensureStoryStateMigrated } from '@/services/story-state-service'
import { PlotThreadTab, TimelineTab } from './StoryStateTabs'
import { useNovelStore } from '@/stores'
import type { Chapter } from '@shared/types'

const TAB_ITEMS = [
  { id: 'state-card', label: '状态卡', icon: Target },
  { id: 'characters', label: '角色', icon: Users },
  { id: 'foreshadow', label: '伏笔', icon: Flag },
  { id: 'timeline', label: '时间线', icon: Clock },
  { id: 'threads', label: '剧情线', icon: GitBranch },
  { id: 'recent', label: '最近章节', icon: BookOpen },
  { id: 'risks', label: '风险', icon: AlertTriangle },
]

export default function TrackingPanel({ novelId }: { novelId: string }) {
  const [trackingState, setTrackingState] = useState<TrackingState | null>(null)
  const [activeTab, setActiveTab] = useState('state-card')
  const [isLoading, setIsLoading] = useState(true)
  const [recentChapters, setRecentChapters] = useState<Chapter[]>([])
  const [constraints, setConstraints] = useState<string>('')
  const [risks, setRisks] = useState<string>('')
  // D-T5-1：状态卡显示书名而非 novelId
  const novelTitle = useNovelStore((s) => s.novels.find((n) => n.id === novelId)?.title)

  const stateFilePath = `content/tracking/${novelId}.json`

  // Load tracking state
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        // Try to load existing tracking state from file
        let state: TrackingState
        try {
          const exists = await window.electronAPI?.file.exists(stateFilePath)
          if (exists) {
            const raw = await window.electronAPI!.file.read(stateFilePath)
            state = JSON.parse(raw) as TrackingState
          } else {
            state = createDefaultState(novelId)
          }
        } catch {
          state = createDefaultState(novelId)
        }

        if (cancelled) return
        setTrackingState(state)
        setConstraints((state.longTermConstraints || []).join('\n'))
        setRisks((state.coherenceRisks || []).join('\n'))

        // P1：旧项目懒迁移（确定性 id + INSERT OR IGNORE，可重复执行）
        try {
          const [characters, foreshadowings] = await Promise.all([
            characterService.getByNovelId(novelId),
            foreshadowingService.getByNovelId(novelId),
          ])
          await ensureStoryStateMigrated(novelId, {
            characters,
            foreshadowings,
            currentChapterOrder: state.currentPosition?.chapter ?? 0,
          })
        } catch (e) {
          console.warn('[tracking] story state migrate failed:', e)
        }

        // Load recent chapters for context
        if (state.recentChapters.length > 0) {
          try {
            // Try to fetch chapter details (we already have titles from tracking state)
            // The tracking state keeps summaries directly
          } catch {}
        }
      } catch (err) {
        console.error('Failed to load tracking state:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [novelId])

  // Auto-save tracking state when changed
  useEffect(() => {
    if (!trackingState || isLoading) return
    const save = async () => {
      try {
        await window.electronAPI?.file.write(stateFilePath, JSON.stringify(trackingState, null, 2))
      } catch (err) {
        console.error('Failed to save tracking state:', err)
      }
    }
    save()
  }, [trackingState])

  // Save long-term constraints
  const handleSaveConstraints = () => {
    if (!trackingState) return
    setTrackingState((prev) => prev ? {
      ...prev,
      longTermConstraints: constraints.split('\n').filter((l) => l.trim()),
    } : null)
  }

  // Save risks
  const handleSaveRisks = () => {
    if (!trackingState) return
    setTrackingState((prev) => prev ? {
      ...prev,
      coherenceRisks: risks.split('\n').filter((l) => l.trim()),
    } : null)
  }

  const stateCardContent = useMemo(() => {
    if (!trackingState) return ''
    return generateStateCard(trackingState, novelTitle)
  }, [trackingState, novelTitle])

  const characterSnapshots = useMemo(() => {
    if (!trackingState) return {}
    return generateCharacterSnapshots(trackingState)
  }, [trackingState])

  const foreshadowContent = useMemo(() => {
    if (!trackingState) return ''
    return generateForeshadowView(trackingState)
  }, [trackingState])

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  if (!trackingState) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        无法加载追踪状态
      </div>
    )
  }

  const resolvedHooks = trackingState.activeForeshadowings.filter((f) => f.status === 'resolved').length
  const activeHooks = trackingState.activeForeshadowings.filter((f) => f.status !== 'resolved').length

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center px-3 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">创作追踪</span>
          <span className="text-[10px] text-muted-foreground/60">
            v{trackingState.revision}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground/60">
          <span>位置: {trackingState.currentPosition.volume} Ch.{trackingState.currentPosition.chapter}</span>
          <span>伏笔: {activeHooks}活跃 / {resolvedHooks}已回收</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/20 px-2 overflow-x-auto">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs border-b-2 transition-colors flex-shrink-0',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon size={12} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* State Card Tab */}
        {activeTab === 'state-card' && (
          <div className="p-4">
            <h3 className="text-sm font-semibold mb-3">续写状态卡</h3>
            <pre className="text-xs leading-relaxed text-muted-foreground bg-muted/20 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap font-mono max-h-[calc(100vh-260px)]">
              {stateCardContent}
            </pre>
          </div>
        )}

        {/* Characters Tab */}
        {activeTab === 'characters' && (
          <div className="p-4 space-y-4">
            <h3 className="text-sm font-semibold">角色状态快照</h3>
            {Object.keys(characterSnapshots).length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无角色状态记录</p>
            ) : (
              Object.entries(characterSnapshots).map(([name, snapshot]) => (
                <div key={name} className="bg-muted/20 rounded-lg p-4">
                  <pre className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono">
                    {snapshot}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        {/* Foreshadow Tab */}
        {activeTab === 'foreshadow' && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">伏笔追踪</h3>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400">
                  {activeHooks} 活跃
                </span>
                <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">
                  {resolvedHooks} 已回收
                </span>
              </div>
            </div>
            <pre className="text-xs leading-relaxed text-muted-foreground bg-muted/20 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap font-mono">
              {foreshadowContent}
            </pre>
          </div>
        )}

        {/* Timeline Tab */}
        {activeTab === 'timeline' && <TimelineTab novelId={novelId} />}

        {/* Plot Threads Tab */}
        {activeTab === 'threads' && (
          <PlotThreadTab novelId={novelId} currentChapter={trackingState.currentPosition.chapter} />
        )}

        {/* Recent Chapters Tab */}
        {activeTab === 'recent' && (
          <div className="p-4 space-y-4">
            <h3 className="text-sm font-semibold">近三章速记</h3>
            {trackingState.recentChapters.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无章节记录</p>
            ) : (
              trackingState.recentChapters.map((ch) => (
                <div key={ch.chapter} className="bg-muted/20 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-foreground">
                    第{ch.chapter}章 · {ch.title}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                    {ch.summary || '暂无摘要'}
                  </p>
                  {ch.keyEvents && ch.keyEvents.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {ch.keyEvents.map((event, i) => (
                        <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary">
                          {event}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Risks Tab */}
        {activeTab === 'risks' && (
          <div className="p-4 space-y-4">
            <h3 className="text-sm font-semibold">长期约束 & 连贯性风险</h3>

            {/* Long-term constraints */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">长期约束 (每行一条)</label>
              <textarea
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                rows={4}
                placeholder="例：主角不能杀人&#10;魔法体系不得添加新元素&#10;时间线必须在冬季结束前..."
                className="w-full mt-1 px-3 py-2 rounded-lg text-sm bg-muted/20 border border-border/40 resize-none"
              />
              <div className="flex justify-end mt-1">
                <button
                  onClick={handleSaveConstraints}
                  className="text-xs text-primary hover:underline"
                >
                  保存约束
                </button>
              </div>
            </div>

            {/* Promises */}
            {trackingState.nextChapterPromises.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1.5">下一章承诺</h4>
                <div className="space-y-1">
                  {trackingState.nextChapterPromises.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1">
                      <Flag size={10} className="text-yellow-400" />
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Coherence risks */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">连贯性风险 (每行一条)</label>
              <textarea
                value={risks}
                onChange={(e) => setRisks(e.target.value)}
                rows={4}
                placeholder="例：第5章设定主角不会游泳，第12章跳海救人..."
                className="w-full mt-1 px-3 py-2 rounded-lg text-sm bg-muted/20 border border-border/40 resize-none"
              />
              <div className="flex justify-end mt-1">
                <button
                  onClick={handleSaveRisks}
                  className="text-xs text-primary hover:underline"
                >
                  保存风险
                </button>
              </div>
            </div>

            {/* Timeline */}
            {trackingState.timelineAuthor.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1.5">作者时间线</h4>
                <div className="space-y-0.5">
                  {trackingState.timelineAuthor.slice(-10).map((t, i) => (
                    <div key={i} className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-0.5">
                      Ch.{t.chapter}: {t.event}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
