import { motion } from 'framer-motion'
import { Wand2, Image, Clapperboard, Network } from 'lucide-react'
import { DISK_SKILLS } from '@/skills'
import { useWorkbenchStore } from '@/stores'
import WorldGraph from './WorldGraph'
import { cn } from '@/utils/cn'

// story-recall 技能已删除（RAG 召回已内建到续写/审查上下文装配），此前的 F_META 死代码条目一并移除
const F_META: Record<string, { icon: typeof Wand2; desc: string }> = {
  'story-cover': { icon: Image, desc: '生成 AI 绘图封面提示词与构图配色' },
  'story-adapt': { icon: Clapperboard, desc: '改编为漫画分镜 / 短剧脚本 / 有声大纲' },
}

export default function DerivativePanel({ novelId }: { novelId: string }) {
  const setPendingSkillInject = useWorkbenchStore((s) => s.setPendingSkillInject)
  const toggleRightCollapsed = useWorkbenchStore((s) => s.toggleRightCollapsed)
  const isRightCollapsed = useWorkbenchStore((s) => s.isRightCollapsed)

  const fSkills = DISK_SKILLS.filter((s) => s.phaseGroup === 'F')

  const inject = (id: string, name: string) => {
    setPendingSkillInject(`请使用「${name}」技能处理当前作品。`)
    if (isRightCollapsed) toggleRightCollapsed()
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mb-4 flex items-center gap-2">
        <Wand2 size={15} className="text-sky-300" />
        <h3 className="text-sm font-semibold text-foreground">衍生工坊 · F 阶段</h3>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {fSkills.map((s) => {
          const meta = F_META[s.id] || { icon: Wand2, desc: s.description }
          const Icon = meta.icon
          return (
            <motion.div
              key={s.id}
              whileHover={{ scale: 1.02, y: -2 }}
              className="relative rounded-xl border border-white/10 bg-white/[0.03] p-3 backdrop-blur-md"
            >
              <div className="flex items-center gap-1.5">
                <Icon size={14} className="text-sky-300" />
                <span className="text-[13px] font-medium text-foreground">{s.name}</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
                {meta.desc}
              </p>
              <button
                onClick={() => inject(s.id, s.name)}
                className={cn(
                  'mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-sky-300 hover:text-sky-200'
                )}
              >
                注入对话 →
              </button>
            </motion.div>
          )
        })}
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <Network size={14} className="text-violet-300" />
          <span className="text-xs font-semibold text-violet-300">世界观 / RAG 图谱</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] backdrop-blur-md">
          <WorldGraph novelId={novelId} />
        </div>
      </div>
    </div>
  )
}
