import { describe, it, expect } from 'vitest'
import { pickAgentForRole } from '../agent-service'
import type { AgentConfig } from '@shared/types'

function cfg(partial: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a', name: 'A', role: 'writer', provider: 'deepseek', model: 'm',
    temperature: 0.7, maxTokens: 4096, apiKeyEncrypted: '', systemPrompt: '',
    skillRefs: [], isActive: true,
    ...partial,
  } as AgentConfig
}

describe('pickAgentForRole（D-T4-2：空 key 种子行与用户行并存时按角色选取）', () => {
  it('优先选已配 key 的行，即使空 key 种子行排在前面（模拟 agent_configs rowid 序）', () => {
    const seed = cfg({ id: 'agent-writer-default', role: 'writer', apiKeyEncrypted: '' })
    const user = cfg({ id: 'agent-123', role: 'writer', apiKeyEncrypted: 'enc' })
    expect(pickAgentForRole([seed, user], 'writer')?.id).toBe('agent-123')
    expect(pickAgentForRole([user, seed], 'writer')?.id).toBe('agent-123')
  })

  it('全部无 key 时回退列表第一行', () => {
    const a = cfg({ id: 'a', role: 'checker', apiKeyEncrypted: '' })
    const b = cfg({ id: 'b', role: 'checker', apiKeyEncrypted: '' })
    expect(pickAgentForRole([a, b], 'checker')?.id).toBe('a')
  })

  it('多个有 key 行取列表首个，保证选择稳定', () => {
    const late = cfg({ id: 'late', role: 'writer', apiKeyEncrypted: 'enc2' })
    const early = cfg({ id: 'early', role: 'writer', apiKeyEncrypted: 'enc1' })
    expect(pickAgentForRole([late, early], 'writer')?.id).toBe('late')
  })

  it('角色不存在返回 undefined；其它角色行不干扰', () => {
    const w = cfg({ id: 'w', role: 'writer', apiKeyEncrypted: 'enc' })
    expect(pickAgentForRole([w], 'checker')).toBeUndefined()
  })
})
