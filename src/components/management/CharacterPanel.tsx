import { useState, useEffect, useRef } from 'react'
import { Plus, User, Users, Crown, Swords, Trash2, Save, Loader2, Wand2, Sparkles, Square } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { characterService } from '@/services/data-service'
import { listCharacterStateTimeline } from '@/services/story-state-service'
import { extractCharacters, craftCharacter, type CharacterProgress } from '@/services/ai-character'
import { reindexCharacter, removeCharacterIndex } from '@/services/rag-service'
import type { Character, CharacterState } from '@shared/types'

const ROLE_ICONS = {
  protagonist: <Crown size={14} />,
  antagonist: <Swords size={14} />,
  supporting: <User size={14} />,
  functional: <Users size={14} />,
}

const ROLE_COLORS = {
  protagonist: 'text-yellow-400 bg-yellow-500/10',
  antagonist: 'text-red-400 bg-red-500/10',
  supporting: 'text-blue-400 bg-blue-500/10',
  functional: 'text-muted-foreground bg-muted/30',
}

const ROLE_LABELS: Record<Character['role'], string> = {
  protagonist: '主角',
  antagonist: '对手',
  supporting: '配角',
  functional: '功能性角色',
}

const GENDER_LABELS: Record<NonNullable<Character['gender']>, string> = {
  male: '男',
  female: '女',
  other: '其他',
  unknown: '未知',
}

const STATE_STATUS_LABELS: Record<CharacterState['status'], string> = {
  active: '在场',
  dead: '已死亡',
  missing: '失踪',
  retired: '退场',
}

export default function CharacterPanel({ novelId }: { novelId: string }) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [editData, setEditData] = useState<Partial<Character>>({})
  const [stateTimeline, setStateTimeline] = useState<CharacterState[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newChar, setNewChar] = useState<Character>({
    id: '', novelId, name: '', role: 'supporting', gender: 'unknown', age: '',
    personality: '', appearance: '', profile: '', dynamicState: '',
  })

  // ===== AI 角色提取/构筑 =====
  const [reloadKey, setReloadKey] = useState(0)
  const [aiProgress, setAiProgress] = useState<CharacterProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // D-T4-1：进度自动清除定时器统一持有，避免「上一次 error/done 的旧定时器」误清新一次运行中的进度
  const progressTimerRef = useRef<number | null>(null)
  const [showCraft, setShowCraft] = useState(false)
  const [craftGender, setCraftGender] = useState('')
  const [craftRole, setCraftRole] = useState('')

  // Load characters from database
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const chars = await characterService.getByNovelId(novelId)
        if (!cancelled) setCharacters(chars)
      } catch (err) {
        console.error('Failed to load characters:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [novelId, reloadKey])

  const filtered = characters.filter((c) =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const selected = characters.find((c) => c.id === selectedId)

  // P1：角色状态时间线（按章只读展示）
  useEffect(() => {
    if (!selectedId) {
      setStateTimeline([])
      return
    }
    let cancelled = false
    listCharacterStateTimeline(novelId, selectedId)
      .then((list) => { if (!cancelled) setStateTimeline(list) })
      .catch((e) => { console.error('[character] load state timeline failed:', e) })
    return () => { cancelled = true }
  }, [novelId, selectedId])

  const handleSelect = (char: Character) => {
    setSelectedId(char.id === selectedId ? null : char.id)
    setEditMode(false)
    setShowCreate(false)
  }

  const handleDelete = async (id: string) => {
    try {
      await characterService.delete(id)
      setCharacters((prev) => prev.filter((c) => c.id !== id))
      if (selectedId === id) setSelectedId(null)
      // P2-10：删除角色后增量移除 RAG 分块
      try { removeCharacterIndex(novelId, id) } catch (e) { console.error('RAG removeCharacterIndex failed:', e) }
    } catch (err) {
      console.error('Failed to delete character:', err)
    }
  }

  // ===== AI 角色提取/构筑 =====
  const clearProgressTimer = () => {
    if (progressTimerRef.current !== null) {
      clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }

  // D-T4-1：error 相位也自动清除（catch 分支此前只 set 不清除，导致按钮永久卡死不可重试）
  const showError = (message: string) => {
    clearProgressTimer()
    setAiProgress({ phase: 'error', message })
    progressTimerRef.current = window.setTimeout(() => {
      setAiProgress(null)
      progressTimerRef.current = null
    }, 4000)
  }

  const showDoneThenClear = (delay: number) => {
    clearProgressTimer()
    progressTimerRef.current = window.setTimeout(() => {
      setAiProgress(null)
      progressTimerRef.current = null
    }, delay)
  }

  const cancelAI = () => {
    abortRef.current?.abort()
    abortRef.current = null
    clearProgressTimer()
    setAiProgress(null)
  }

  const runExtract = async () => {
    if (aiProgress) return
    clearProgressTimer()
    const controller = new AbortController()
    abortRef.current = controller
    setAiProgress({ phase: 'prepare', message: '准备中…' })
    try {
      for await (const p of extractCharacters(novelId, { signal: controller.signal })) {
        setAiProgress(p)
        if (p.phase === 'error') { showError(p.message ?? '角色提取失败'); return }
        if (p.phase === 'done') { setReloadKey((k) => k + 1); showDoneThenClear(3000); return }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') showError(`错误: ${e.message}`)
      else { clearProgressTimer(); setAiProgress(null) }
    } finally {
      abortRef.current = null
    }
  }

  const runCraft = async () => {
    if (aiProgress) return
    clearProgressTimer()
    setShowCraft(false)
    const controller = new AbortController()
    abortRef.current = controller
    setAiProgress({ phase: 'llm', message: '正在构筑新角色…' })
    try {
      for await (const p of craftCharacter(novelId, {
        gender: craftGender ? (craftGender as 'male' | 'female' | 'other') : undefined,
        role: craftRole ? (craftRole as 'protagonist' | 'antagonist' | 'supporting' | 'functional') : undefined,
        signal: controller.signal,
      })) {
        setAiProgress(p)
        if (p.phase === 'error') { showError(p.message ?? '角色构筑失败'); return }
        if (p.phase === 'done') { setReloadKey((k) => k + 1); showDoneThenClear(3000); return }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') showError(`错误: ${e.message}`)
      else { clearProgressTimer(); setAiProgress(null) }
    } finally {
      abortRef.current = null
    }
  }

  const handleEditSave = async () => {
    if (!selected || !editData) return
    try {
      await characterService.update(selected.id, editData)
      const merged = { ...selected, ...editData } as Character
      setCharacters((prev) =>
        prev.map((c) => (c.id === selected.id ? merged : c))
      )
      setEditMode(false)
      // P2-10：编辑角色后增量 upsert RAG 分块
      try { reindexCharacter(novelId, merged) } catch (e) { console.error('RAG reindexCharacter failed:', e) }
    } catch (err) {
      console.error('Failed to update character:', err)
    }
  }

  const handleCreate = async () => {
    if (!newChar.name.trim()) return
    const char: Character = {
      id: crypto.randomUUID(),
      novelId,
      name: newChar.name.trim(),
      role: newChar.role,
      gender: newChar.gender,
      age: newChar.age,
      personality: newChar.personality,
      appearance: newChar.appearance,
      profile: newChar.profile,
      dynamicState: newChar.dynamicState,
    }
    try {
      await characterService.create(char)
      setCharacters((prev) => [...prev, char])
      setSelectedId(char.id)
      setShowCreate(false)
      // P2-10：新建角色后增量 upsert RAG 分块
      try { reindexCharacter(novelId, char) } catch (e) { console.error('RAG reindexCharacter failed:', e) }
      setNewChar({
        id: '', novelId, name: '', role: 'supporting', gender: 'unknown', age: '',
        personality: '', appearance: '', profile: '', dynamicState: '',
      })
    } catch (err) {
      console.error('Failed to create character:', err)
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center px-3 py-2.5 border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">角色管理</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={runExtract}
            disabled={!!aiProgress}
            className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 text-[10px] hover:bg-emerald-500/25 disabled:opacity-40"
          >
            <Wand2 size={11} /> 提取
          </button>
          <button
            onClick={() => setShowCraft(true)}
            disabled={!!aiProgress}
            className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 text-[10px] hover:bg-cyan-500/25 disabled:opacity-40"
          >
            <Sparkles size={11} /> 构筑
          </button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => { setShowCreate(true); setSelectedId(null); setEditMode(false) }}
          >
            <Plus size={13} />
          </Button>
        </div>
      </div>

      {/* 构筑角色弹窗 */}
      {showCraft && !aiProgress && (
        <div className="px-3 py-2.5 border-b border-border/30 bg-cyan-500/5 space-y-2">
          <div className="text-[10px] text-cyan-300 font-medium">构筑新角色</div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">性别:</span>
            <select value={craftGender} onChange={(e) => setCraftGender(e.target.value)} className="px-1.5 py-0.5 rounded bg-muted/40 border border-border/30">
              <option value="">不限</option>
              <option value="male">男</option>
              <option value="female">女</option>
              <option value="other">其他</option>
            </select>
            <span className="text-muted-foreground ml-2">定位:</span>
            <select value={craftRole} onChange={(e) => setCraftRole(e.target.value)} className="px-1.5 py-0.5 rounded bg-muted/40 border border-border/30">
              <option value="">不限</option>
              <option value="protagonist">主角</option>
              <option value="antagonist">反派</option>
              <option value="supporting">配角</option>
              <option value="functional">功能性</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={runCraft} className="px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 text-[10px] hover:bg-cyan-500/30">开始构筑</button>
            <button onClick={() => setShowCraft(false)} className="px-2 py-1 rounded bg-muted/40 text-foreground/60 text-[10px] hover:bg-muted/60">取消</button>
          </div>
        </div>
      )}

      {/* AI 进度 */}
      {aiProgress && (
        <div className={cn(
          'px-3 py-2 border-b text-[10px] space-y-1',
          aiProgress.phase === 'error' ? 'bg-red-500/5 border-red-500/20 text-red-400'
            : aiProgress.phase === 'done' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
              : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300',
        )}>
          <div className="flex items-center gap-1.5">
            {aiProgress.phase !== 'done' && aiProgress.phase !== 'error' && <Loader2 size={10} className="animate-spin" />}
            <span>
              {aiProgress.phase === 'chapter' && aiProgress.total
                ? `[${(aiProgress.index ?? 0) + 1}/${aiProgress.total}]${aiProgress.title ? ` ${aiProgress.title}` : ''} — ${aiProgress.message ?? ''}`
                : aiProgress.message ?? ''}
            </span>
            {aiProgress.phase !== 'done' && aiProgress.phase !== 'error' && (
              <button onClick={cancelAI} className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">
                <Square size={8} /> 停止
              </button>
            )}
            {/* D-T4-1：错误横幅可手动关闭，立即恢复重试入口（不必等 4s 自动清除） */}
            {aiProgress.phase === 'error' && (
              <button onClick={() => { clearProgressTimer(); setAiProgress(null) }} className="ml-auto px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 hover:bg-red-500/25">
                关闭
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 flex">
        {/* Character List */}
        <div className="w-56 flex-shrink-0 border-r border-border/20 flex flex-col">
          <div className="p-2">
            <Input
              type="text"
              placeholder="搜索角色..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-7 text-xs bg-muted/20"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground/60">
                {characters.length === 0 ? '暂无角色' : '无匹配角色'}
              </div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleSelect(c)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors',
                    selectedId === c.id
                      ? 'bg-primary/10 text-foreground border-l-[3px] border-primary -ml-[1px]'
                      : 'text-muted-foreground hover:bg-muted/20 border-l-[3px] border-transparent -ml-[1px]'
                  )}
                >
                  <span className={cn('p-1 rounded', ROLE_COLORS[c.role])}>
                    {ROLE_ICONS[c.role]}
                  </span>
                  <span>{c.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Character Detail / Create */}
        <div className="flex-1 p-4 overflow-y-auto">
          {showCreate ? (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">新建角色</h3>
              <div>
                <label className="text-[10px] text-muted-foreground">姓名 *</label>
                <Input
                  value={newChar.name}
                  onChange={(e) => setNewChar((p) => ({ ...p, name: e.target.value }))}
                  className="mt-1 h-8 text-xs"
                  placeholder="角色姓名"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">角色定位</label>
                <div className="flex gap-1.5 mt-1">
                  {(Object.entries(ROLE_LABELS) as [Character['role'], string][]).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setNewChar((p) => ({ ...p, role: key }))}
                      className={cn(
                        'px-2 py-1 rounded text-xs transition-colors',
                        newChar.role === key ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-muted/20 text-muted-foreground border border-transparent'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground">性别</label>
                  <select
                    value={newChar.gender}
                    onChange={(e) => setNewChar((p) => ({ ...p, gender: e.target.value as Character['gender'] }))}
                    className="w-full mt-1 h-8 px-1.5 rounded text-xs bg-muted/20 border border-border/40"
                  >
                    {(Object.entries(GENDER_LABELS) as [NonNullable<Character['gender']>, string][]).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">年龄</label>
                  <Input
                    value={newChar.age}
                    onChange={(e) => setNewChar((p) => ({ ...p, age: e.target.value }))}
                    className="mt-1 h-8 text-xs"
                    placeholder="如：18 / 外表20岁"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">外貌描写</label>
                <textarea
                  value={newChar.appearance}
                  onChange={(e) => setNewChar((p) => ({ ...p, appearance: e.target.value }))}
                  className="w-full mt-1 px-2 py-1.5 rounded text-xs bg-muted/20 border border-border/40 resize-none h-16"
                  placeholder="角色的容貌、身材、衣着、标志性特征..."
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">性格特点</label>
                <textarea
                  value={newChar.personality}
                  onChange={(e) => setNewChar((p) => ({ ...p, personality: e.target.value }))}
                  className="w-full mt-1 px-2 py-1.5 rounded text-xs bg-muted/20 border border-border/40 resize-none h-16"
                  placeholder="性格、口头禅、习惯、优缺点..."
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">角色档案</label>
                <textarea
                  value={newChar.profile}
                  onChange={(e) => setNewChar((p) => ({ ...p, profile: e.target.value }))}
                  className="w-full mt-1 px-2 py-1.5 rounded text-xs bg-muted/20 border border-border/40 resize-none h-20"
                  placeholder="角色的背景、经历、动机..."
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">当前动态</label>
                <Input
                  value={newChar.dynamicState}
                  onChange={(e) => setNewChar((p) => ({ ...p, dynamicState: e.target.value }))}
                  className="mt-1 h-8 text-xs"
                  placeholder="角色当前所处状态"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleCreate} disabled={!newChar.name.trim()}>
                  <Plus size={12} className="mr-1" /> 创建
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>取消</Button>
              </div>
            </div>
          ) : selected ? (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-xl font-bold text-primary">
                    {selected.name[0]}
                  </div>
                  <div>
                    {editMode ? (
                      <Input
                        value={editData.name || selected.name}
                        onChange={(e) => setEditData((p) => ({ ...p, name: e.target.value }))}
                        className="h-8 text-sm font-semibold"
                      />
                    ) : (
                      <h3 className="font-semibold text-foreground">{selected.name}</h3>
                    )}
                    {editMode ? (
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <div className="flex gap-1">
                          {(Object.entries(ROLE_LABELS) as [Character['role'], string][]).map(([key, label]) => (
                            <button
                              key={key}
                              onClick={() => setEditData((p) => ({ ...p, role: key }))}
                              className={cn(
                                'px-1.5 py-0.5 rounded text-[10px]',
                                (editData.role || selected.role) === key
                                  ? 'bg-primary/20 text-primary border border-primary/30'
                                  : 'bg-muted/20 text-muted-foreground border border-transparent'
                              )}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <select
                          value={editData.gender || selected.gender || 'unknown'}
                          onChange={(e) => setEditData((p) => ({ ...p, gender: e.target.value as Character['gender'] }))}
                          className="h-6 px-1 rounded text-[10px] bg-muted/20 border border-border/40"
                        >
                          {(Object.entries(GENDER_LABELS) as [NonNullable<Character['gender']>, string][]).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                          ))}
                        </select>
                        <Input
                          value={editData.age ?? selected.age ?? ''}
                          onChange={(e) => setEditData((p) => ({ ...p, age: e.target.value }))}
                          className="h-6 w-28 text-[10px]"
                          placeholder="年龄"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge className={cn(ROLE_COLORS[selected.role])}>
                          {ROLE_LABELS[selected.role]}
                        </Badge>
                        {(selected.gender && selected.gender !== 'unknown') && (
                          <Badge variant="outline" className="text-[10px]">{GENDER_LABELS[selected.gender]}</Badge>
                        )}
                        {selected.age && (
                          <Badge variant="outline" className="text-[10px]">{selected.age}</Badge>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  {editMode ? (
                    <Button size="icon-sm" variant="ghost" onClick={handleEditSave}>
                      <Save size={13} className="text-green-400" />
                    </Button>
                  ) : (
                    <Button
                      size="icon-sm" variant="ghost"
                      onClick={() => { setEditData({ ...selected }); setEditMode(true) }}
                    >
                      <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </Button>
                  )}
                  <Button
                    size="icon-sm" variant="ghost"
                    onClick={() => handleDelete(selected.id)}
                  >
                    <Trash2 size={13} className="text-red-400" />
                  </Button>
                </div>
              </div>

              {/* Appearance */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">外貌描写</h4>
                {editMode ? (
                  <textarea
                    value={editData.appearance ?? selected.appearance ?? ''}
                    onChange={(e) => setEditData((p) => ({ ...p, appearance: e.target.value }))}
                    className="w-full px-2 py-1.5 rounded text-sm bg-muted/20 border border-border/40 resize-none h-16"
                    placeholder="容貌、身材、衣着、标志性特征..."
                  />
                ) : selected.appearance ? (
                  <p className="text-sm text-muted-foreground leading-relaxed">{selected.appearance}</p>
                ) : null}
              </div>

              {/* Personality */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">性格特点</h4>
                {editMode ? (
                  <textarea
                    value={editData.personality ?? selected.personality ?? ''}
                    onChange={(e) => setEditData((p) => ({ ...p, personality: e.target.value }))}
                    className="w-full px-2 py-1.5 rounded text-sm bg-muted/20 border border-border/40 resize-none h-16"
                    placeholder="性格、口头禅、习惯、优缺点..."
                  />
                ) : selected.personality ? (
                  <p className="text-sm text-muted-foreground leading-relaxed">{selected.personality}</p>
                ) : null}
              </div>

              {/* Profile */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">角色档案</h4>
                {editMode ? (
                  <textarea
                    value={editData.profile ?? selected.profile}
                    onChange={(e) => setEditData((p) => ({ ...p, profile: e.target.value }))}
                    className="w-full px-2 py-1.5 rounded text-sm bg-muted/20 border border-border/40 resize-none h-24"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground leading-relaxed">{selected.profile}</p>
                )}
              </div>

              {/* Dynamic State */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">当前动态</h4>
                {editMode ? (
                  <Input
                    value={editData.dynamicState ?? selected.dynamicState}
                    onChange={(e) => setEditData((p) => ({ ...p, dynamicState: e.target.value }))}
                    className="h-8 text-sm"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{selected.dynamicState}</p>
                )}
              </div>

              {/* P1：状态时间线 */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">状态时间线</h4>
                {stateTimeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">
                    暂无按章状态快照；角色动态会在后续章节推进时累积到这里。
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {stateTimeline.map((s) => (
                      <div key={s.id} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary tabular-nums">
                            {s.chapterId === '__migrated__' ? '既有状态' : `第${s.chapterOrder}章`}
                          </span>
                          <span className={cn(
                            'px-1 rounded',
                            s.status === 'dead' ? 'bg-red-500/10 text-red-400'
                              : s.status === 'missing' ? 'bg-amber-500/10 text-amber-400'
                                : 'bg-white/5'
                          )}>
                            {STATE_STATUS_LABELS[s.status]}
                          </span>
                          {s.location && <span>{s.location}</span>}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          {s.items.length > 0 && (
                            <span>物品 {s.items.map((i) => i.name).join('、')}</span>
                          )}
                          {s.abilities.length > 0 && (
                            <span>能力 {s.abilities.map((a) => a.name).join('、')}</span>
                          )}
                          {s.knowledge.knows.length > 0 && (
                            <span>已知 {s.knowledge.knows.length} 条</span>
                          )}
                        </div>
                        {s.note && (
                          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">{s.note}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              选择一个角色查看详情，或点击 + 创建新角色
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
