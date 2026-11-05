import { useEffect, useState, useMemo } from 'react'
import { volumeService, chapterService } from '@/services/data-service'
import { cn } from '@/utils/cn'

interface GNode {
  id: string
  label: string
  x: number
  y: number
  kind: 'volume' | 'chapter'
  score?: number
}
interface GEdge {
  from: string
  to: string
}

// P5：本书世界 + RAG 图谱可视化（势力/卷章结构 + 伏笔连线）
export default function WorldGraph({ novelId }: { novelId: string }) {
  const [nodes, setNodes] = useState<GNode[]>([])
  const [edges, setEdges] = useState<GEdge[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const vols = await volumeService.getByNovelId(novelId)
        const ns: GNode[] = []
        const es: GEdge[] = []
        const W = 520
        let vy = 40
        for (let vi = 0; vi < vols.length; vi++) {
          const vol = vols[vi]
          const chapters = await chapterService.getByVolumeId(vol.id)
          const vx = 60 + (vi % 3) * 200
          ns.push({ id: `v-${vol.id}`, label: vol.title?.slice(0, 8) || `卷${vi + 1}`, x: vx, y: vy, kind: 'volume' })
          let cx = vx - 40
          for (let ci = 0; ci < chapters.length; ci++) {
            const ch = chapters[ci]
            ns.push({
              id: `c-${ch.id}`,
              label: `第${ch.order}章`,
              x: cx,
              y: vy + 40 + ci * 22,
              kind: 'chapter',
              score: (ch as any).qualityScore,
            })
            es.push({ from: `v-${vol.id}`, to: `c-${ch.id}` })
            cx += 70
            if (cx > vx + 140) cx = vx - 40
          }
          vy += 40 + chapters.length * 22 + 30
        }
        // 伏笔连线（来自 tracking 的 activeForeshadowings）
        try {
          const exists = await window.electronAPI?.file.exists(`content/tracking/${novelId}.json`)
          if (exists) {
            const raw = await window.electronAPI!.file.read(`content/tracking/${novelId}.json`)
            const state = JSON.parse(raw)
            const fs = state.activeForeshadowings || []
            for (const f of fs) {
              if (f.plantChapterId && f.resolveChapterId) {
                es.push({ from: `c-${f.plantChapterId}`, to: `c-${f.resolveChapterId}` })
              }
            }
          }
        } catch {}
        if (!cancelled) {
          setNodes(ns)
          setEdges(es)
          setLoading(false)
        }
      } catch (e) {
        console.error('WorldGraph load failed:', e)
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [novelId])

  const edgePaths = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return edges
      .map((e) => {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b) return null
        return { id: `${e.from}->${e.to}`, a, b }
      })
      .filter(Boolean) as { id: string; a: GNode; b: GNode }[]
  }, [nodes, edges])

  if (loading) {
    return <div className="p-6 text-xs text-muted-foreground">图谱加载中…</div>
  }
  if (nodes.length === 0) {
    return <div className="p-6 text-xs text-muted-foreground">暂无章节数据，先写几章即可生成世界观图谱。</div>
  }

  const scoreColor = (s?: number) =>
    s == null ? '#64748B' : s >= 80 ? '#22C55E' : s >= 60 ? '#F59E0B' : '#EF4444'

  return (
    <div className="overflow-auto p-3">
      <svg width={560} height={Math.max(420, nodes.reduce((m, n) => Math.max(m, n.y), 0) + 40)} className="mx-auto">
        {edgePaths.map((e) => (
          <line
            key={e.id}
            x1={e.a.x}
            y1={e.a.y}
            x2={e.b.x}
            y2={e.b.y}
            stroke="#6366F1"
            strokeOpacity={0.35}
            strokeWidth={1.5}
          />
        ))}
        {nodes.map((n) =>
          n.kind === 'volume' ? (
            <g key={n.id}>
              <rect x={n.x - 18} y={n.y - 12} width={120} height={24} rx={6} fill="#1E293B" stroke="#8B5CF6" strokeOpacity={0.6} />
              <text x={n.x + 42} y={n.y + 4} textAnchor="middle" fontSize={11} fill="#E2E8F0">{n.label}</text>
            </g>
          ) : (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r={5} fill={scoreColor(n.score)} />
              <text x={n.x + 9} y={n.y + 3} fontSize={9} fill="#94A3B8">{n.label}</text>
            </g>
          )
        )}
      </svg>
      <div className="mt-2 flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />≥80</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-500 inline-block" />60-79</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-red-500 inline-block" />＜60</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-slate-500 inline-block" />未评</span>
      </div>
    </div>
  )
}
