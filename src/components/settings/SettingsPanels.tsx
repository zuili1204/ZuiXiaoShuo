import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { ActionLog } from '@/services/log-service'
import { checkForUpdate } from '@/services/update-checker'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// 外观: 明暗主题切换
export function AppearancePanel() {
  const theme = useSettingsStore((s) => s.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">外观</h2>
        <p className="mt-1 text-xs text-muted-foreground">选择软件的界面主题。</p>
      </div>

      <div className="flex gap-3">
        {(['dark', 'light'] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTheme(t)
              ActionLog.settings('appearance-theme', t)
            }}
            className={
              'flex-1 rounded-lg border px-4 py-6 text-sm transition-colors ' +
              (theme === t
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border/50 text-muted-foreground hover:border-border')
            }
          >
            <div className="text-base font-medium">{t === 'dark' ? '暗色' : '亮色'}</div>
            <div className="mt-1 text-[11px] opacity-70">{t === 'dark' ? '适合夜间写作' : '适合白天写作'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// 显示: 内容文件存储路径（数据库固定留在 userData）
type DataPaths = { userData: string; contentDir: string; defaultContentDir: string; databasePath: string }

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function DisplayPanel() {
  const dataPath = useSettingsStore((s) => s.dataPath)
  const setDataPath = useSettingsStore((s) => s.setDataPath)
  const [draft, setDraft] = useState(dataPath)
  const [paths, setPaths] = useState<DataPaths | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI?.data
    if (!api?.getPaths) return
    api.getPaths()
      .then((p) => {
        if (!cancelled) setPaths(p)
      })
      .catch((e) => {
        if (!cancelled) setMessage({ kind: 'error', text: `读取存储路径失败：${(e as Error).message}` })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const chooseFolder = async () => {
    const picked = await window.electronAPI?.dialog?.selectDirectory?.()
    if (picked) {
      setDraft(picked)
      setMessage(null)
    }
  }

  const applyPath = async () => {
    const target = draft.trim()
    if (!target) return
    setBusy(true)
    setMessage(null)
    try {
      const api = window.electronAPI?.data
      if (!api?.setContentDir) throw new Error('当前环境不支持切换数据目录')
      const res = await api.setContentDir(target)
      setPaths((prev) => (prev ? { ...prev, contentDir: res.contentDir } : prev))
      // 主进程已落库；同步 store 让设置页立即反映新值（重复写入同一值，幂等）
      setDataPath(res.contentDir)
      setDraft(res.contentDir)
      setMessage({
        kind: 'ok',
        text: `已迁移 ${res.copiedFiles} 个文件并切换。旧目录文件保留未删除，确认无误后可手动清理。`,
      })
      ActionLog.settings('display-datapath', res.contentDir)
    } catch (e) {
      setMessage({ kind: 'error', text: `切换失败：${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  const sameAsCurrent = !!paths && normalizePath(draft.trim()) === normalizePath(paths.contentDir)

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">显示</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          正文、快照、模板等文件的存放位置；数据库固定保存在系统应用数据目录。
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">内容目录</label>
        <div className="flex gap-2">
          <Input
            value={draft}
            placeholder={paths ? `当前：${paths.contentDir}` : '例如: D:/ZuiXiaoShuo/Data'}
            onChange={(e) => {
              setDraft(e.target.value)
              setMessage(null)
            }}
            className="flex-1"
          />
          <Button variant="outline" onClick={chooseFolder} disabled={busy}>
            选择目录
          </Button>
          <Button onClick={applyPath} disabled={busy || !draft.trim() || sameAsCurrent}>
            {busy ? '迁移中...' : '迁移并切换'}
          </Button>
        </div>
      </div>

      {paths && (
        <div className="space-y-1 rounded-lg border border-border/50 bg-muted/30 p-3 text-[11px] text-muted-foreground">
          <div>
            当前内容目录：<span className="break-all text-foreground/80">{paths.contentDir}</span>
          </div>
          <div>
            数据库文件：<span className="break-all text-foreground/80">{paths.databasePath}</span>
            （固定位置，不随目录切换迁移）
          </div>
          <div className="pt-1">
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setDraft(paths.defaultContentDir)
                setMessage(null)
              }}
              disabled={busy}
            >
              恢复默认目录
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className={message.kind === 'ok' ? 'text-xs text-emerald-500' : 'text-xs text-destructive'}>
          {message.text}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        切换时会把现有文件复制到新目录；目标目录存在同名文件时会整体中止，不覆盖任何文件。
      </p>
    </div>
  )
}

// API 密钥: 按 Agent 配置加密保存（持久化）
export function ApiKeysPanel() {
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)
  const updateAgentConfig = useSettingsStore((s) => s.updateAgentConfig)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const saveKey = async (id: string) => {
    const plain = (drafts[id] || '').trim()
    if (!plain) return
    setSaving(id)
    try {
      const encrypted = await window.electronAPI.key.encrypt(plain)
      updateAgentConfig(id, { apiKeyEncrypted: encrypted })
      setDrafts((prev) => ({ ...prev, [id]: '' }))
      ActionLog.settings('apikey-save', id)
    } catch (e) {
      console.error('Failed to encrypt api key:', e)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">API 密钥</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          为每个智能体配置对应模型商的密钥，使用系统级加密保存在本地，重启不丢。
        </p>
      </div>

      <div className="space-y-3">
        {agentConfigs.length === 0 && (
          <p className="text-xs text-muted-foreground/60">暂无智能体配置，请先在「Agent 配置」中创建。</p>
        )}
        {agentConfigs.map((agent) => (
          <div key={agent.id} className="rounded-lg border border-border/50 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-foreground font-medium">{agent.name}</div>
              <div className="text-[11px] text-muted-foreground">
                {agent.provider} · {agent.model || '未设模型'}
              </div>
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                value={drafts[agent.id] || ''}
                placeholder={agent.apiKeyEncrypted ? '已保存（输入新值以覆盖）' : 'sk-...'}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && saveKey(agent.id)}
              />
              <Button
                variant="outline"
                disabled={!drafts[agent.id]?.trim() || saving === agent.id}
                onClick={() => saveKey(agent.id)}
              >
                {saving === agent.id ? '保存中' : '保存密钥'}
              </Button>
              {agent.apiKeyEncrypted && (
                <span className="self-center text-[11px] text-green-400">√ 已加密</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// 关于 / 更新检查
export function AboutPanel() {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    // getVersion 走 IPC，返回 Promise；组件可能先卸载，故用 cancelled 兜底避免更新已卸载组件
    window.electronAPI.app
      .getVersion()
      .then((v) => { if (!cancelled) setVersion(v || '') })
      .catch(() => { if (!cancelled) setVersion('') })
    return () => { cancelled = true }
  }, [])

  const checkUpdate = async () => {
    setChecking(true)
    setStatus(null)
    try {
      // manifestUrl 留空时仅显示当前版本（离线安全）
      const info = await checkForUpdate()
      if (info.hasUpdate) {
        setStatus({ ok: true, text: `发现新版本 ${info.latestVersion}，请前往官网下载。` })
      } else {
        setStatus({ ok: true, text: '当前已是最新版本。' })
      }
    } catch (e) {
      setStatus({ ok: false, text: `检查失败：${(e as Error).message}` })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">关于</h2>
        <p className="mt-1 text-xs text-muted-foreground">醉小说 · 本地优先的 AI 长篇小说创作工具。</p>
      </div>

      <div className="rounded-lg border border-border/50 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">当前版本</span>
          <span className="text-xs font-mono text-foreground">{version || '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={checkUpdate} disabled={checking}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
          {status && (
            <span className={status.ok ? 'text-[11px] text-green-400' : 'text-[11px] text-red-400'}>
              {status.text}
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          所有作品与密钥均保存在本地，不上传云端。
        </p>
      </div>
    </div>
  )
}

// 隐私与权限：数据去向 / 系统权限 / 免责声明
export function PrivacyPanel() {
  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">隐私与权限</h2>
        <p className="mt-1 text-xs text-muted-foreground">你的数据在哪里、AI 功能时发生了什么、本软件需要哪些权限。</p>
      </div>

      <section className="rounded-lg border border-border/50 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-foreground">数据存在哪</h3>
        <ul className="text-xs text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>作品、大纲、知识库、创作追踪与设置全部保存在你电脑的本地数据目录中，可在「显示」设置中查看与修改位置。</li>
          <li>醉小说不内置任何账号体系，不收集、不上传任何统计数据或使用行为记录。</li>
          <li>API 密钥使用系统级加密保存在本地，界面中不可反查明文。</li>
        </ul>
      </section>

      <section className="rounded-lg border border-border/50 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-foreground">使用 AI 功能时，数据去了哪</h3>
        <ul className="text-xs text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>只有当你主动触发 AI 功能（对话、生成、润稿、校验等）时，软件才会把与该任务相关的文本（如正文片段、大纲、设定摘要）发送给你自己配置的模型服务商接口。</li>
          <li>醉小说本身不中转、不留存这些请求内容；请求是否被服务商记录，取决于该服务商的隐私政策，请自行了解并确认。</li>
          <li>不配置任何 AI 服务时，本软件的所有功能均不产生网络请求。</li>
        </ul>
      </section>

      <section className="rounded-lg border border-border/50 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-foreground">需要哪些系统权限</h3>
        <ul className="text-xs text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>磁盘读写：保存稿件、数据库与导出文件到你的数据目录。</li>
          <li>网络访问：连接你配置的 AI 模型接口与检查更新。</li>
          <li>系统对话框：选择数据目录与导出位置时调用系统文件夹选择器。</li>
        </ul>
      </section>

      <section className="rounded-lg border border-border/50 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-foreground">使用注意</h3>
        <ul className="text-xs text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>AI 生成内容可能存在事实错误或与你的构思不符，发布前请务必本人审阅校对。</li>
          <li>重要作品请定期导出备份；请勿把 API 密钥分享给他人。</li>
          <li>发布作品时请遵守目标平台的规范，AI 参与创作的比例要求以平台规则为准。</li>
        </ul>
      </section>

      <section className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-amber-400/90">免责声明</h3>
        <ul className="text-xs text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
          <li>本软件按「现状」提供，不做任何明示或默示的担保，包括但不限于适用性、稳定性与不侵权。</li>
          <li>对 AI 生成内容的准确性、合法性、原创性不作担保；由此产生的作品纠纷、平台审核与账号处罚，由使用者自行承担。</li>
          <li>因误操作、系统故障或第三方服务中断导致的数据丢失，请以你自己的备份为准，本软件不承担赔偿责任。</li>
          <li>第三方模型服务的可用性与费用由对应服务商负责，与你产生的费用纠纷与本项目无关。</li>
        </ul>
        <p className="text-[10px] text-muted-foreground/60 pt-1">下载、安装或继续使用本软件，即表示你已阅读并理解以上全部内容。</p>
      </section>
    </div>
  )
}
