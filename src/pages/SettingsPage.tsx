import { useState } from 'react'
import { ArrowLeft, Monitor, Palette, Cpu, Key, Info, ShieldCheck, Feather } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import TitleBar from '@/components/layout/TitleBar'
import AgentConfigPanel from '@/components/settings/AgentConfigPanel'
import StyleDefaultsPanel from '@/components/settings/StyleDefaultsPanel'
import { AppearancePanel, DisplayPanel, ApiKeysPanel, AboutPanel, PrivacyPanel } from '@/components/settings/SettingsPanels'
import { cn } from '@/utils/cn'
import { ActionLog } from '@/services/log-service'

type TabKey = 'agents' | 'display' | 'api-keys' | 'style' | 'appearance' | 'about' | 'privacy'

const TABS: { key: TabKey; icon: typeof Cpu; label: string }[] = [
  { key: 'agents', icon: Cpu, label: 'Agent 配置' },
  { key: 'display', icon: Monitor, label: '显示' },
  { key: 'api-keys', icon: Key, label: 'API 密钥' },
  { key: 'style', icon: Feather, label: '文风分析' },
  { key: 'appearance', icon: Palette, label: '外观' },
  { key: 'about', icon: Info, label: '关于' },
  { key: 'privacy', icon: ShieldCheck, label: '隐私与权限' },
]

export default function SettingsPage() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabKey>('agents')

  const selectTab = (key: TabKey, label: string) => {
    setActiveTab(key)
    ActionLog.nav('settings-tab', label)
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <TitleBar />

      <div className="flex-1 flex overflow-hidden mt-9">
        {/* Sidebar */}
        <div className="w-56 flex-shrink-0 border-r border-border/40 bg-sidebar flex flex-col">
          <div className="px-3 py-4">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft size={14} />
              返回首页
            </button>
          </div>

          <div className="px-3 py-2 border-t border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">设置</span>
          </div>

          <nav className="flex-1 px-2 space-y-0.5 py-2">
            {TABS.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => selectTab(key, label)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-xs rounded transition-colors text-left',
                  activeTab === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
                )}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'agents' && <AgentConfigPanel />}
          {activeTab === 'appearance' && <AppearancePanel />}
          {activeTab === 'display' && <DisplayPanel />}
          {activeTab === 'api-keys' && <ApiKeysPanel />}
          {activeTab === 'style' && <StyleDefaultsPanel />}
          {activeTab === 'about' && <AboutPanel />}
          {activeTab === 'privacy' && <PrivacyPanel />}
        </div>
      </div>
    </div>
  )
}
