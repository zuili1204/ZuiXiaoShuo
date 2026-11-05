import { useState } from 'react'
import {
  ArrowLeft,
  Rocket,
  LayoutGrid,
  Cpu,
  BookOpen,
  Users,
  GitBranch,
  Workflow,
  Download,
  Globe,
  Swords,
  Library,
  Clapperboard,
  Wrench,
  Wand2,
  MessageSquare,
  PenLine,
  Search,
  Settings,
  ListTree,
  Lightbulb,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import TitleBar from '@/components/layout/TitleBar'
import { cn } from '@/utils/cn'
import { ActionLog } from '@/services/log-service'
import { AGENT_ROLE_LABELS } from '@shared/constants'

type SectionKey = 'quickstart' | 'features' | 'agents'

const SECTIONS: { key: SectionKey; icon: typeof Cpu; label: string; desc: string }[] = [
  { key: 'quickstart', icon: Rocket, label: '快速上手', desc: '六步走完第一本书' },
  { key: 'features', icon: LayoutGrid, label: '功能说明', desc: '每个按钮是干嘛的' },
  { key: 'agents', icon: Cpu, label: 'Agent 配置', desc: '让 AI 帮你写' },
]

const STEPS: { title: string; body: string }[] = [
  {
    title: '新建作品',
    body: '首页点「新建小说」，填好书名、类型、简介就能开工；已经有存稿的话，直接「导入小说」丢个 txt/md 进来也行。',
  },
  {
    title: '定大纲',
    body: '进工作台点顶部【大纲】→「新建大纲向导」，四步走：创意提案 → 主线分卷 → 章纲骨架 → 确认落库。信息随便填多少——只给一个书名也行，剩下的 AI 帮你补，你填过的内容都会原样保留。',
  },
  {
    title: '攒设定',
    body: '【设定】管角色卡、【世界观】管世界规则、【势力】管组织门派。写过的内容会自动沉淀进【知识库】，AI 动笔前会先翻资料，避免写着写着忘了自己埋的伏笔。',
  },
  {
    title: '开写',
    body: '中间的编辑器是纯手写区；右侧「AI 对话」可以聊灵感、要片段。想省事就点【流水线】，四位 Agent 按 审稿者 → 作者 → 润稿者 → 读者 的顺序自动产稿，你也可以在关键节点自己拍板。',
  },
  {
    title: '回头看',
    body: '【追踪】帮你盯伏笔回收和人物弧线；正文大改之后，点【大纲】→「重订走向」，未写章节的规划会跟着正文重新对齐——放心，已写章节一个字都不会动。',
  },
  {
    title: '拿走作品',
    body: '顶部【导出】，选 MD 或 TXT，整本打包带走。数据都在你自己电脑上，随时可迁。',
  },
]

const FEATURES: { icon: typeof BookOpen; name: string; desc: string }[] = [
  { icon: ListTree, name: '章节目录', desc: '左侧章节树：卷与章节的新建、改名、排序，点一下即切章写作。' },
  { icon: PenLine, name: '写作编辑器', desc: '中间的写作区，自动保存、实时字数统计，配合右侧面板边查边写。' },
  { icon: MessageSquare, name: 'AI 对话', desc: '右侧对话面板，自动带上本书资料来回答；「问询」模式纯聊天，不会往正文里塞东西。' },
  { icon: BookOpen, name: '大纲', desc: '大纲管理 + 新建大纲向导（AI 四步生成全书走向）+ 重订走向（正文改动后校准未写章节的规划）。' },
  { icon: Library, name: '知识库', desc: '本书的剧情记忆：章节摘要、伏笔、人物卡、世界观规则。支持一键自动构建，AI 写作时自动引用。' },
  { icon: Users, name: '设定', desc: '角色卡管理：外貌、性格、人物关系、说话口癖，供 AI 与你自己随时查阅。' },
  { icon: Globe, name: '世界观', desc: '世界规则与背景设定，长篇不崩设定的保险栓。' },
  { icon: Swords, name: '势力', desc: '组织、门派、阵营的档案与相互关系。' },
  { icon: GitBranch, name: '追踪', desc: '创作追踪：伏笔埋设与回收、人物弧线推进，一眼看清哪里挖了坑没填。' },
  { icon: Workflow, name: '流水线', desc: '四位 Agent 自动协作写章：审稿者定架构 → 作者写正文 → 润稿者磨文风 → 读者做校验。' },
  { icon: Clapperboard, name: '导演', desc: '全局编排模式：拆解意图、派发任务，关键节点等你人工审批再继续。' },
  { icon: Wrench, name: '技能', desc: '技能版图：选一个技能一键注入对话，让 AI 按固定套路干活。' },
  { icon: Wand2, name: '衍生', desc: '衍生工坊：封面绘图提示词、漫画分镜 / 短剧脚本 / 有声大纲改编，附世界观图谱可视化。' },
  { icon: Search, name: '搜索', desc: '全书内容检索，写到后面忘了前面在哪埋的梗，一搜就有。' },
  { icon: Download, name: '导出', desc: '按 MD 或 TXT 格式导出全书或所选范围。' },
  { icon: Settings, name: '设置', desc: 'Agent 配置、API 密钥、显示（数据存储位置）、外观（明暗主题）、关于与隐私说明。' },
]

const CORE_ROLES = ['architect', 'writer', 'polisher', 'checker'] as const
const EXTENDED_ROLES = ['planner', 'runtime', 'director', 'consistency'] as const

const CONFIG_STEPS = [
  '打开【设置】→「Agent 配置」，点角色卡片新建或编辑，填入接口地址与模型名。',
  '到「API 密钥」页给对应角色保存密钥（系统级加密，只存在你本机）。',
  '回到工作台即可使用。没配密钥时相关功能会提示「模拟」模式，配好即变真实对话。',
]

const PAIRING_TIPS = [
  { role: '审稿者 / 读者', tip: '选推理能力强的模型——它们负责搭结构和找茬。' },
  { role: '作者', tip: '选长文输出稳定的模型——它负责产出正文，稳字当头。' },
  { role: '润稿者', tip: '选便宜快速的模型——打磨文风的活儿，量大但不难。' },
]

export default function HelpPage() {
  const navigate = useNavigate()
  const [active, setActive] = useState<SectionKey>('quickstart')

  const select = (key: SectionKey, label: string) => {
    setActive(key)
    ActionLog.nav('help-tab', label)
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
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">帮助</span>
          </div>

          <nav className="flex-1 px-2 space-y-0.5 py-2">
            {SECTIONS.map(({ key, icon: Icon, label, desc }) => (
              <button
                key={key}
                onClick={() => select(key, label)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1.5 text-xs rounded transition-colors text-left',
                  active === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
                )}
              >
                <Icon size={13} />
                <span className="flex flex-col">
                  {label}
                  <span className="text-[9px] opacity-60">{desc}</span>
                </span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {active === 'quickstart' && <QuickStartSection />}
          {active === 'features' && <FeaturesSection />}
          {active === 'agents' && <AgentsSection />}
        </div>
      </div>
    </div>
  )
}

// 快速上手：六步流程
function QuickStartSection() {
  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">快速上手</h2>
        <p className="mt-1 text-xs text-muted-foreground">从空白到成稿导出，一共六步。每一步都可以只用一半、也可以全用。</p>
      </div>

      <div className="space-y-3">
        {STEPS.map((step, i) => (
          <div key={step.title} className="rounded-lg border border-border/50 p-4 flex gap-3">
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">
              {i + 1}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">{step.title}</div>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{step.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border/50 bg-muted/20 p-4 flex gap-2.5">
        <Lightbulb size={14} className="flex-shrink-0 mt-0.5 text-amber-400" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          建议的第一本书玩法：先「新建小说」→ 大纲向导只填书名让 AI 补全 → 挑一章点【流水线】看四位 Agent 怎么协作 → 满意就继续，不满意就「重订走向」。
          全程不配 AI 也完全能用，纯手写一切功能照常。
        </p>
      </div>
    </div>
  )
}

// 功能说明：卡片矩阵
function FeaturesSection() {
  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">功能说明</h2>
        <p className="mt-1 text-xs text-muted-foreground">工作台顶部一排按钮 + 编辑器三栏，各自负责什么。</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {FEATURES.map(({ icon: Icon, name, desc }) => (
          <div key={name} className="rounded-lg border border-border/50 p-3.5">
            <div className="flex items-center gap-1.5">
              <Icon size={13} className="text-primary" />
              <span className="text-xs font-medium text-foreground">{name}</span>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// Agent 配置：角色分工 + 配置步骤 + 推荐搭配
function AgentsSection() {
  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Agent 配置</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          软件里的 AI 以「编辑部」的方式分工：每个角色一个配置，指向你自己的模型服务商接口。
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-foreground">四位核心角色</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {CORE_ROLES.map((role) => {
            const meta = AGENT_ROLE_LABELS[role]
            return (
              <div key={role} className="rounded-lg border border-border/50 p-3.5">
                <div className="text-xs font-medium text-foreground">
                  {meta.emoji} {meta.name}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">{meta.description}</p>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          另外：{EXTENDED_ROLES.map((r) => `${AGENT_ROLE_LABELS[r].name}（${AGENT_ROLE_LABELS[r].description}）`).join('、')}
          ，主要服务于「导演」编排模式，可按需配置。
        </p>
      </section>

      <section className="rounded-lg border border-border/50 p-4 space-y-2.5">
        <h3 className="text-xs font-semibold text-foreground">怎么配</h3>
        <ol className="space-y-2">
          {CONFIG_STEPS.map((step, i) => (
            <li key={i} className="flex gap-2.5 text-xs text-muted-foreground leading-relaxed">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-semibold flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-foreground">选模型小抄</h3>
        <div className="space-y-1.5">
          {PAIRING_TIPS.map(({ role, tip }) => (
            <div key={role} className="rounded-lg border border-border/50 px-3.5 py-2.5 flex items-start gap-2.5">
              <span className="text-[11px] font-medium text-foreground flex-shrink-0 mt-0.5">{role}</span>
              <span className="text-[11px] text-muted-foreground leading-relaxed">{tip}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed pt-1">
          提示：模型费用由你选择的服务商收取，与醉小说无关；不配置任何 Agent，本软件仍是完整的本地写作工具。
        </p>
      </section>
    </div>
  )
}
