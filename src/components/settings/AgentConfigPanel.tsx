import { useState, useEffect } from 'react'
import { Plus, Save, Trash2, Settings2, Link2, Bot, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@/stores'
import { cn } from '@/utils/cn'
import { AGENT_ROLE_LABELS, LLM_PROVIDERS, PROVIDER_ORDER, DEFAULT_AGENT_CONFIGS } from '@shared/constants'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { getAvailableSkills } from '@/services/skill-service'
import { testConnection } from '@/services/llm-service'
import type { AgentConfig, Skill } from '@shared/types'

const ALL_SKILLS: Skill[] = getAvailableSkills()

export default function AgentConfigPanel() {
  const { agentConfigs, updateAgentConfig, addAgentConfig } = useSettingsStore()
  const [selectedId, setSelectedId] = useState<string | null>(
    agentConfigs[0]?.id || null
  )
  const [showNewForm, setShowNewForm] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const selected = agentConfigs.find((c) => c.id === selectedId)

  // 切换选中 Agent 时清空明文 Key 输入
  useEffect(() => {
    setKeyInput('')
    setShowKey(false)
  }, [selectedId])

  const handleSaveKey = async () => {
    if (!selected) return
    const plain = keyInput.trim()
    if (!plain) return
    try {
      const encrypted = await window.electronAPI.key.encrypt(plain)
      // 防御：encrypt 返回空值时不覆盖已有密钥
      if (!encrypted) {
        console.warn('encrypt returned empty, skipping save')
        return
      }
      updateAgentConfig(selected.id, { apiKeyEncrypted: encrypted })
      setKeyInput('')
      setShowKey(false)
    } catch (e) {
      console.error('Failed to encrypt API key:', e)
    }
  }

  const initDefaults = () => {
    if (agentConfigs.length === 0) {
      const defaults = DEFAULT_AGENT_CONFIGS.map((d) => ({
        ...d,
        id: `agent-${d.role}-default`,
        apiKeyEncrypted: '',
        skillRefs: [],
        isActive: true,
      }))
      defaults.forEach((d) => addAgentConfig(d as AgentConfig))
    }
  }

  const createNew = (role: AgentConfig['role']) => {
    const id = `agent-${Date.now()}`
    const defaults = DEFAULT_AGENT_CONFIGS.find(d => d.role === role)!
    addAgentConfig({
      id,
      name: defaults.name,
      role,
      provider: defaults.provider,
      model: defaults.model,
      temperature: defaults.temperature,
      maxTokens: defaults.maxTokens,
      apiKeyEncrypted: '',
      systemPrompt: defaults.systemPrompt,
      skillRefs: [...(defaults.skillRefs || [])],
      isActive: true,
    })
    setSelectedId(id)
    setShowNewForm(false)
  }

  if (!selected && !showNewForm) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-semibold text-foreground">Agent 配置</h2>
          <Button size="sm" variant="outline" onClick={initDefaults}>恢复默认</Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(AGENT_ROLE_LABELS) as AgentConfig['role'][]).map((role) => (
            <button
              key={role}
              onClick={() => createNew(role)}
              className={cn(
                'flex items-center gap-3 p-4 rounded-xl border border-border/50',
                'hover:border-primary/30 hover:bg-primary/[0.03]',
                'transition-all duration-150 text-left'
              )}
            >
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-lg">
                {AGENT_ROLE_LABELS[role].emoji}
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{AGENT_ROLE_LABELS[role].name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{AGENT_ROLE_LABELS[role].description}</div>
              </div>
              <Plus size={14} className="ml-auto text-muted-foreground" />
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (showNewForm) {
    return (
      <div className="p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">新建 Agent</h2>
        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(AGENT_ROLE_LABELS) as AgentConfig['role'][]).map((role) => (
            <button
              key={role}
              onClick={() => createNew(role)}
              className="p-4 rounded-xl border border-border/50 hover:border-primary/30 hover:bg-primary/[0.03] transition-all text-left"
            >
              <span className="text-lg">{AGENT_ROLE_LABELS[role].emoji}</span>
              <span className="ml-2 text-sm font-medium">{AGENT_ROLE_LABELS[role].name}</span>
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-4" onClick={() => setShowNewForm(false)}>取消</Button>
      </div>
    )
  }

  const roleLabel = AGENT_ROLE_LABELS[selected!.role]
  if (!roleLabel) {
    return (
      <div className="p-6">
        <div className="text-sm text-red-400">当前 Agent 角色无效：{String(selected!.role)}</div>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setShowNewForm(true)}>重新配置</Button>
      </div>
    )
  }
  // 显式标注类型：LLM_PROVIDERS 各条目字面量联合后 .models 会被推断为元组联合，
  // 导致 .includes() 的参数退化为 never。
  const providerInfo: {
    name: string
    defaultModel: string
    models: string[]
    endpoint: string
    customEndpoint: boolean
  } = LLM_PROVIDERS[selected!.provider as keyof typeof LLM_PROVIDERS] || LLM_PROVIDERS.openai

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-lg">
            {roleLabel.emoji}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{roleLabel.name}</h2>
            <p className="text-xs text-muted-foreground">{roleLabel.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => setShowNewForm(true)}><Plus size={13} /></Button>
          <Button size="icon-sm" variant="ghost" className="text-red-400 hover:bg-red-500/10"><Trash2 size={13} /></Button>
        </div>
      </div>

      {/* Agent Tabs */}
      <div className="flex gap-1 bg-muted/30 rounded-lg p-0.5">
        {agentConfigs.map((c) => {
          const rl = AGENT_ROLE_LABELS[c.role]
          if (!rl) return null
          return (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs transition-all',
                selectedId === c.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span>{rl.emoji}</span>
              <span className="hidden sm:inline">{rl.name}</span>
            </button>
          )
        })}
      </div>

      {/* Config Form */}
      <div className="space-y-4">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">名称</label>
          <Input
            value={selected!.name ?? ''}
            onChange={(e) => updateAgentConfig(selected!.id, { name: e.target.value })}
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">API Provider（模型商）</label>
          <div className="flex gap-1.5 flex-wrap">
            {PROVIDER_ORDER.map((p) => (
              <button
                key={p}
                onClick={() => {
                  const info = LLM_PROVIDERS[p]
                  // 切换到已知 Provider 时强制使用其默认模型，避免沿用其它 Provider 的非法模型名导致 400
                  const patch: Partial<AgentConfig> = { provider: p }
                  if (p !== 'custom' && info.defaultModel) patch.model = info.defaultModel
                  if (p !== 'custom') patch.endpoint = undefined
                  updateAgentConfig(selected!.id, patch)
                }}
                className={cn(
                  'px-3 py-1.5 rounded-md text-[11px] transition-all border',
                  selected!.provider === p
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'bg-muted/20 text-muted-foreground border-transparent hover:border-border'
                )}
              >
                {LLM_PROVIDERS[p].name}
              </button>
            ))}
          </div>
          {selected!.provider === 'anthropic' && (
            <p className="text-[10px] text-amber-400/80 mt-1.5 leading-relaxed">
              Anthropic 协议暂不支持工具循环：该角色只能使用写作前装配好的章节资料，无法主动查询知识库或改写章节。
            </p>
          )}
        </div>

        {selected!.provider === 'custom' && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              自定义接口地址（Endpoint / Base URL）
            </label>
            <Input
              placeholder="https://your-gateway/v1"
              value={selected!.endpoint || ''}
              onChange={(e) => updateAgentConfig(selected!.id, { endpoint: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              需兼容 OpenAI Chat Completions 协议；留空将使用内置默认地址。
            </p>
          </div>
        )}

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            模型（可自由输入，如 deepseek-V4-flase）
          </label>
          <div className="flex gap-2">
            <select
              value={providerInfo.models.includes(selected!.model) ? selected!.model : ''}
              onChange={(e) => updateAgentConfig(selected!.id, { model: e.target.value })}
              className="h-8 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">— 自定义 / 其他 —</option>
              {providerInfo.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <Input
              placeholder="输入任意模型名"
              value={selected!.model ?? ''}
              onChange={(e) => updateAgentConfig(selected!.id, { model: e.target.value })}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            下拉为常用建议，文本框可填任意模型名，二者同步。
          </p>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
          <div className="flex gap-2">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder="sk-... 或自定义密钥"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? '隐藏' : '显示'}
            >
              {showKey ? '隐藏' : '显示'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleSaveKey}
              title="加密保存到本地"
            >
              保存密钥
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {selected!.apiKeyEncrypted ? '√ 已加密保存，重启不丢。' : '未保存密钥。'}
          </p>
          <div className="flex items-center gap-2 mt-2">
            <Button
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={async () => {
                setTesting(true)
                setTestResult(null)
                const res = await testConnection(selected!)
                setTestResult(res)
                setTesting(false)
              }}
            >
              {testing ? '测试中…' : '测试链接'}
            </Button>
            {testResult && (
              <span className={cn('text-[11px]', testResult.ok ? 'text-green-400' : 'text-red-400')}>
                {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">
              Temperature: {selected!.temperature ?? 0}
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={selected!.temperature ?? 0}
              onChange={(e) => updateAgentConfig(selected!.id, { temperature: parseFloat(e.target.value) })}
              className="w-full accent-primary"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">
              Max Tokens: {selected!.maxTokens ?? 0}
            </label>
            <input
              type="range"
              min="512"
              max="32768"
              step="512"
              value={selected!.maxTokens ?? 0}
              onChange={(e) => updateAgentConfig(selected!.id, { maxTokens: parseInt(e.target.value) })}
              className="w-full accent-primary"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Top-P（核采样，0~1）：{selected!.topP ?? '默认'}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={selected!.topP ?? 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              updateAgentConfig(selected!.id, { topP: v >= 1 ? undefined : v })
            }}
            className="w-full accent-primary"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            与 Temperature 配合抑制"每句都写漂亮"的修辞过载；拉到 1 即不限制（使用模型默认）。
          </p>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1 block">系统提示词</label>
          <textarea
            value={selected!.systemPrompt ?? ''}
            onChange={(e) => updateAgentConfig(selected!.id, { systemPrompt: e.target.value })}
            rows={4}
            className="w-full px-3 py-2 rounded-lg resize-none bg-muted/30 border border-border/60 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
            <Sparkles size={12} className="text-primary" />
            绑定技能
          </label>
          <div className="flex flex-wrap gap-1.5">
            {ALL_SKILLS.map((skill) => {
              const active = selected!.skillRefs?.includes(skill.id)
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => {
                    const refs = selected!.skillRefs || []
                    const next = active
                      ? refs.filter((r) => r !== skill.id)
                      : [...refs, skill.id]
                    updateAgentConfig(selected!.id, { skillRefs: next })
                  }}
                  title={skill.description}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] border transition-all',
                    active
                      ? 'bg-primary/15 text-primary border-primary/40'
                      : 'bg-muted/20 text-muted-foreground border-transparent hover:border-border'
                  )}
                >
                  {skill.name}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1.5">
            绑定的技能会在该 Agent 执行时自动注入对应流程指令。
          </p>
        </div>
      </div>
    </div>
  )
}
