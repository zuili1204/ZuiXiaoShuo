import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { loadStyleDefaults, saveStyleDefaults, type StyleDefaults } from '@/services/style-service'
import { agentConfigService } from '@/services/data-service'
import type { AgentConfig } from '@shared/types'

const SAMPLE_OPTIONS: { value: StyleDefaults['sampleCount']; label: string }[] = [
  { value: 12, label: '12 章（快速）' },
  { value: 24, label: '24 章（推荐）' },
  { value: 30, label: '30 章（最细）' },
]

export default function StyleDefaultsPanel() {
  const [draft, setDraft] = useState<StyleDefaults>({ sampleCount: 24, anchorMode: 'excerpt', agentId: '' })
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void loadStyleDefaults().then(setDraft)
    agentConfigService.getAll()
      .then((rows) => setAgents(rows.filter((a) => a.apiKeyEncrypted)))
      .catch(() => setAgents([]))
  }, [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await saveStyleDefaults(draft)
      setMsg({ ok: true, text: '文风分析设置已保存' })
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">文风分析</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          控制生成文风画像时的抽样规模、锚点方式与使用的模型。只影响新发起的分析。
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">抽样章节数</label>
        <select
          value={draft.sampleCount}
          onChange={(e) => setDraft({ ...draft, sampleCount: Number(e.target.value) as StyleDefaults['sampleCount'] })}
          className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-sm text-foreground focus:outline-none"
        >
          {SAMPLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="text-[10px] text-muted-foreground/70">首章、中间章与末章必定包含，其余均匀抽样。</p>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">默认锚点方式</label>
        <select
          value={draft.anchorMode}
          onChange={(e) => setDraft({ ...draft, anchorMode: e.target.value as StyleDefaults['anchorMode'] })}
          className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-sm text-foreground focus:outline-none"
        >
          <option value="excerpt">摘录原文片段</option>
          <option value="paraphrase">改写片段（避免抄袭）</option>
          <option value="abstract">只给抽象描述</option>
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">分析使用的 Agent</label>
        <select
          value={draft.agentId}
          onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
          className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-sm text-foreground focus:outline-none"
        >
          <option value="">自动选择（架构师优先）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}（{a.model}）</option>
          ))}
        </select>
        {!agents.length && (
          <p className="text-[10px] text-amber-400">还没有已配置密钥的 Agent，请先在「Agent 配置」中添加。</p>
        )}
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-[11px] ${msg.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      <Button onClick={save} disabled={busy}>
        {busy ? '保存中…' : '保存设置'}
      </Button>
    </div>
  )
}
