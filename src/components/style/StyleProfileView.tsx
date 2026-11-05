import { useEffect, useState } from 'react'
import { Loader2, Play, RefreshCw, CheckCircle2, Quote, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { listStyleAnchors } from '@/services/style-service'
import { STYLE_ANCHOR_KIND_LABEL } from '@/services/style-blend-service'
import type { StyleAnchor, StyleProfile, StyleSource } from '@shared/style-types'
import { STYLE_FUNCTION_POSITION_LABEL } from '@shared/style-types'
import { cn } from '@/utils/cn'

const KIND_LABEL: Record<string, string> = {
  single_file: '整本文件',
  chapter_dir: '章节目录',
  paste: '粘贴文本',
  deconstruct: '拆书产物',
}
const STATUS_LABEL: Record<string, string> = {
  imported: '待分析',
  analyzing: '分析中',
  ready: '可用',
  failed: '分析失败',
  draft: '草稿',
  stale: '待刷新',
}
const DIMENSION_LABEL: Record<string, string> = {
  pov_tense: '人称与时态',
  syntax: '句法节奏',
  lexicon: '用词习惯',
  dialogue: '对话',
  description: '描写',
  interiority: '心理',
  humor_tone: '幽默与基调',
  characterization: '人物塑造',
  pacing_hooks: '节奏与钩子',
  chapter_engineering: '章节工程',
  hook_design: '钩子设计',
  relationship_engine: '关系引擎',
  setting_function: '设定功能',
  meta_humor: '元叙事与幽默',
  concreteness: '具体度',
  taboo_boundary: '禁忌边界',
  character_voice: '角色声音',
}
const EXPRESSION_DIMENSION_KEYS = new Set([
  'pov_tense',
  'syntax',
  'lexicon',
  'dialogue',
  'description',
  'interiority',
  'humor_tone',
  'characterization',
  'pacing_hooks',
])
const AXIS_ROWS: { key: keyof StyleProfile['payload']['axes']; label: string; unit?: string; scale?: number }[] = [
  { key: 'sentenceAvgLen', label: '平均句长', unit: '字' },
  { key: 'shortSentencePct', label: '短句占比', unit: '%' },
  { key: 'paragraphAvgLen', label: '平均段长', unit: '字' },
  { key: 'dialoguePct', label: '对话占比', unit: '%' },
  { key: 'dialogueAvgLen', label: '单句对话', unit: '字' },
  { key: 'interiorityPct', label: '心理描写', unit: '%' },
  { key: 'simileStrictPer1k', label: '比喻密度', unit: '/千字' },
  { key: 'hookEndingPct', label: '章末钩子', unit: '%' },
  { key: 'colloquialPct', label: '口语化', unit: '%' },
]
const STRUCTURE_AXIS_ROWS: typeof AXIS_ROWS = [
  { key: 'openingInMediaResPct', label: '开篇直入场景', unit: '%' },
  { key: 'endingMedianLen', label: '章末中位长度', unit: '字' },
  { key: 'titleNamePct', label: '标题含角色名', unit: '%' },
  { key: 'concreteObjectPer1k', label: '具体物件', unit: '/千字' },
  { key: 'explanationPer1k', label: '解释句', unit: '/千字' },
  { key: 'publicEventPerChapter', label: '公共事件', unit: '/章' },
  { key: 'tabooRatio', label: '触碰禁忌', unit: '%', scale: 100 },
  { key: 'characterVoiceDispersion', label: '角色声音离散' },
]

function axisValue(profile: StyleProfile, key: keyof StyleProfile['payload']['axes'], scale = 1): string {
  const n = Number(profile.payload.axes[key] ?? 0) * scale
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function confidenceBadge(c: number): string {
  if (c >= 0.75) return 'bg-emerald-500/15 text-emerald-400'
  if (c >= 0.5) return 'bg-amber-500/15 text-amber-400'
  return 'bg-red-500/15 text-red-400'
}

export default function StyleProfileView({
  source,
  profiles,
  analyzing,
  progress,
  onAnalyze,
  onActivate,
}: {
  source: StyleSource
  profiles: StyleProfile[]
  analyzing: boolean
  progress: string | null
  onAnalyze: () => void
  onActivate: (profile: StyleProfile) => Promise<void>
}) {
  const [selectedId, setSelectedId] = useState<string>(profiles[0]?.id ?? '')
  const [anchors, setAnchors] = useState<StyleAnchor[]>([])
  const [activating, setActivating] = useState(false)

  useEffect(() => {
    setSelectedId(profiles[0]?.id ?? '')
  }, [profiles])

  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0]

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setAnchors([])
      return
    }
    listStyleAnchors(selected.id)
      .then((rows) => { if (!cancelled) setAnchors(rows) })
      .catch(() => { if (!cancelled) setAnchors([]) })
    return () => { cancelled = true }
  }, [selected])

  const activate = async () => {
    if (!selected) return
    setActivating(true)
    try {
      await onActivate(selected)
    } finally {
      setActivating(false)
    }
  }

  const expressionDims = selected?.payload.dimensions.filter((d) => EXPRESSION_DIMENSION_KEYS.has(d.key)) ?? []
  const craftDims = selected?.payload.dimensions.filter((d) => !EXPRESSION_DIMENSION_KEYS.has(d.key)) ?? []
  const craft = selected?.payload.craft

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/20 flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{source.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{KIND_LABEL[source.kind] ?? source.kind}</span>
            <span>·</span>
            <span>{source.chapterCount} 章</span>
            <span>·</span>
            <span>{source.charCount.toLocaleString()} 字</span>
            <span className={cn('rounded-full px-1.5 py-0.5', source.status === 'ready' ? 'bg-emerald-500/15 text-emerald-400' : source.status === 'failed' ? 'bg-red-500/15 text-red-400' : 'bg-white/5')}>
              {STATUS_LABEL[source.status] ?? source.status}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto flex-shrink-0"
          onClick={onAnalyze}
          disabled={analyzing}
        >
          {analyzing ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : profiles.length ? <RefreshCw size={12} className="mr-1.5" /> : <Play size={12} className="mr-1.5" />}
          {profiles.length ? '重新分析' : '开始分析'}
        </Button>
      </div>

      {progress && (
        <div className="mx-4 mt-2 rounded-lg bg-primary/10 px-3 py-1.5 text-[11px] text-primary">{progress}</div>
      )}

      {!profiles.length && !analyzing && (
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center text-xs text-muted-foreground/60 leading-relaxed">
          <Sparkles size={26} className="mb-3 text-muted-foreground/40" />
          还没有生成文风画像。
          <br />
          点击「开始分析」抽样阅读语料，提取可复用的表达习惯。
        </div>
      )}

      {selected && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selected.id}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-7 rounded-md border border-border/40 bg-muted/30 px-2 text-[11px] text-foreground focus:outline-none"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  v{p.version} · {STATUS_LABEL[p.status] ?? p.status}
                </option>
              ))}
            </select>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px]', selected.confidence > 0 ? confidenceBadge(selected.confidence) : 'bg-amber-500/15 text-amber-400')}>
              置信度 {selected.confidence > 0 ? `${Math.round(selected.confidence * 100)}%` : '未获取'}
            </span>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
              抽样 {selected.sampleStats.sampledChapters}/{selected.sampleStats.totalChapters} 章
            </span>
            {selected.status !== 'ready' && (
              <Button size="sm" className="ml-auto h-7 px-2 text-[11px]" onClick={activate} disabled={activating}>
                {activating ? <Loader2 size={11} className="mr-1 animate-spin" /> : <CheckCircle2 size={11} className="mr-1" />}
                启用此画像
              </Button>
            )}
            {selected.status === 'ready' && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
                <CheckCircle2 size={11} />已启用
              </span>
            )}
          </div>

          {selected.payload.summary && (
            <p className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-[11px] leading-relaxed text-foreground/90">
              {selected.payload.summary}
            </p>
          )}

          {!selected.payload.dimensions.some((d) => d.value) && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              此版本没有拿到模型的文风结论，只有下方定量特征可用。请检查文风分析模型的配置后重新分析。
            </p>
          )}

          <section>
            <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">表达层：九个维度</h4>
            <div className="space-y-1">
              {expressionDims.map((d) => (
                <div key={d.key} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-foreground">{DIMENSION_LABEL[d.key] ?? d.key}</span>
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                      {d.value ? `${Math.round((d.confidence ?? 0) * 100)}%` : '未获取'}
                    </span>
                  </div>
                  <div className={cn('mt-0.5 text-[11px] leading-relaxed', d.value ? 'text-foreground/80' : 'text-muted-foreground/50')}>
                    {d.value || '本次未提取到该维度'}
                  </div>
                  {!!d.evidence?.length && (
                    <div className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground/70">
                      <Quote size={9} className="mt-0.5 flex-shrink-0" />
                      <span>{d.evidence[0]}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {!!craftDims.length && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">叙事工程层：八个维度</h4>
              <div className="space-y-1">
                {craftDims.map((d) => (
                  <div key={d.key} className="rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-foreground">{DIMENSION_LABEL[d.key] ?? d.key}</span>
                      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                        {d.value ? `${Math.round((d.confidence ?? 0) * 100)}%` : '未获取'}
                      </span>
                    </div>
                    <div className={cn('mt-0.5 text-[11px] leading-relaxed', d.value ? 'text-foreground/80' : 'text-muted-foreground/50')}>
                      {d.value || '本次未提取到该维度'}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">表达定量特征</h4>
            <div className="grid grid-cols-3 gap-1.5">
              {AXIS_ROWS.map(({ key, label, unit, scale }) => (
                <div key={key} className="rounded-lg bg-muted/10 px-2 py-1.5">
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                  <div className="text-xs tabular-nums text-foreground">
                    {axisValue(selected, key, scale)}{unit}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">结构与节奏指纹</h4>
            <div className="grid grid-cols-3 gap-1.5">
              {STRUCTURE_AXIS_ROWS.map(({ key, label, unit, scale }) => (
                <div key={key} className="rounded-lg bg-primary/5 px-2 py-1.5">
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                  <div className="text-xs tabular-nums text-foreground">
                    {axisValue(selected, key, scale)}{unit}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {craft && (
            <>
              {!!craft.functionPositions.length && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">五个功能位</h4>
                  <div className="space-y-1">
                    {craft.functionPositions.map((fp) => (
                      <div key={fp.key} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-foreground">{STYLE_FUNCTION_POSITION_LABEL[fp.key]}</span>
                          <span className={cn('rounded-full px-1.5 py-0.5 text-[9px]', fp.transferable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400')}>
                            {fp.transferable ? '可迁移' : '依赖原设定'}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            设定依赖 {fp.settingDependency === 'low' ? '低' : fp.settingDependency === 'high' ? '高' : '中'}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/80">{fp.description}</p>
                        {!!fp.evidence.length && (
                          <div className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground/70">
                            <Quote size={9} className="mt-0.5 flex-shrink-0" />
                            <span>{fp.evidence[0]}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!!craft.sceneBank.length && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">可重复场景</h4>
                  <div className="space-y-1">
                    {craft.sceneBank.slice(0, 6).map((scene, i) => (
                      <div key={`${scene.scene}-${i}`} className="flex items-start gap-2 rounded-lg bg-muted/10 px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 text-[11px] leading-snug text-foreground/85">{scene.scene}</span>
                        <span className="flex-shrink-0 text-[9px] text-muted-foreground">{scene.function}</span>
                        {scene.frequency > 1 && <span className="flex-shrink-0 text-[9px] tabular-nums text-muted-foreground">×{scene.frequency}</span>}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {!!craft.voices.length && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">角色声音（按功能位）</h4>
                  <div className="space-y-1">
                    {craft.voices.map((v) => (
                      <div key={v.characterRole} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className="text-[11px] text-foreground">{v.characterRole}</span>
                          <span className="ml-auto tabular-nums text-muted-foreground">句均 {Math.round(v.sentenceAvgLen)} 字</span>
                        </div>
                        {!!v.verbalTics.length && (
                          <div className="mt-0.5 text-[10px] text-foreground/75">口头禅：{v.verbalTics.join('、')}</div>
                        )}
                        {!!v.tabooPhrases.length && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground/70">不说：{v.tabooPhrases.join('、')}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(!!craft.chapterEngineering.openingPatterns.length ||
                !!craft.chapterEngineering.endingPatterns.length ||
                !!craft.chapterEngineering.titlePatterns.length) && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">章节工程</h4>
                  <div className="space-y-1 text-[10px]">
                    {!!craft.chapterEngineering.openingPatterns.length && (
                      <div className="rounded-lg bg-muted/10 px-2.5 py-1.5">
                        <span className="text-muted-foreground">开篇：</span>
                        <span className="text-foreground/80">{craft.chapterEngineering.openingPatterns.join('；')}</span>
                      </div>
                    )}
                    {!!craft.chapterEngineering.endingPatterns.length && (
                      <div className="rounded-lg bg-muted/10 px-2.5 py-1.5">
                        <span className="text-muted-foreground">章末：</span>
                        <span className="text-foreground/80">{craft.chapterEngineering.endingPatterns.join('；')}</span>
                      </div>
                    )}
                    {!!craft.chapterEngineering.titlePatterns.length && (
                      <div className="rounded-lg bg-muted/10 px-2.5 py-1.5">
                        <span className="text-muted-foreground">标题：</span>
                        <span className="text-foreground/80">{craft.chapterEngineering.titlePatterns.join('；')}</span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {(!!craft.relationshipEngine.length || !!craft.plotEngine.length) && (
                <section className="grid grid-cols-2 gap-2">
                  {!!craft.relationshipEngine.length && (
                    <div>
                      <h4 className="mb-1.5 text-[11px] font-medium text-emerald-400">关系引擎</h4>
                      <ul className="space-y-1">
                        {craft.relationshipEngine.map((r, i) => (
                          <li key={i} className="rounded bg-emerald-500/5 px-2 py-1 text-[10px] leading-snug text-foreground/80">{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {!!craft.plotEngine.length && (
                    <div>
                      <h4 className="mb-1.5 text-[11px] font-medium text-primary">情节引擎</h4>
                      <ul className="space-y-1">
                        {craft.plotEngine.map((r, i) => (
                          <li key={i} className="rounded bg-primary/5 px-2 py-1 text-[10px] leading-snug text-foreground/80">{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {!!craft.taboos.length && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-red-400">作者不写的东西</h4>
                  <div className="flex flex-wrap gap-1">
                    {craft.taboos.map((t, i) => (
                      <span key={i} className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{t}</span>
                    ))}
                  </div>
                </section>
              )}

              {!!craft.comparison.length && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">作者做法 vs 常见默认</h4>
                  <div className="space-y-1">
                    {craft.comparison.slice(0, 6).map((row, i) => (
                      <div key={`${row.dimension}-${i}`} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5 text-[10px]">
                        <div className="text-[11px] text-foreground">{row.dimension}</div>
                        <div className="mt-0.5 text-foreground/75">作者：{row.author}</div>
                        {!!row.aiDefault && <div className="text-muted-foreground/70">常见默认：{row.aiDefault}</div>}
                        {!!row.rule && <div className="mt-0.5 text-primary/80">照此执行：{row.rule}</div>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {(selected.payload.rules.do.length > 0 || selected.payload.rules.dont.length > 0) && (
            <section className="grid grid-cols-2 gap-2">
              <div>
                <h4 className="mb-1.5 text-[11px] font-medium text-emerald-400">要这样做</h4>
                <ul className="space-y-1">
                  {selected.payload.rules.do.slice(0, 8).map((r, i) => (
                    <li key={i} className="rounded bg-emerald-500/5 px-2 py-1 text-[10px] leading-snug text-foreground/80">{r.text}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="mb-1.5 text-[11px] font-medium text-red-400">不要这样做</h4>
                <ul className="space-y-1">
                  {selected.payload.rules.dont.slice(0, 8).map((r, i) => (
                    <li key={i} className="rounded bg-red-500/5 px-2 py-1 text-[10px] leading-snug text-foreground/80">{r.text}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {!!anchors.length && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">风格锚点</h4>
              <div className="space-y-1">
                {anchors.slice(0, 4).map((a) => (
                  <div key={a.id} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                    <span className="text-[9px] text-primary/80">{STYLE_ANCHOR_KIND_LABEL[a.kind] ?? a.kind}</span>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-foreground/80">{a.text}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
