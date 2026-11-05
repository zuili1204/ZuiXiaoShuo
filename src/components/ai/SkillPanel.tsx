import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Wrench, ArrowRight } from 'lucide-react'
import { DISK_SKILLS, SKILL_PHASE_GROUPS } from '@/skills'
import { useWorkbenchStore } from '@/stores'
import { cn } from '@/utils/cn'
import type { Skill } from '@shared/types'

const GROUP_META: Record<string, { color: string; ring: string }> = {
  A: { color: 'text-cyan-300', ring: 'from-cyan-500/20' },
  B: { color: 'text-indigo-300', ring: 'from-indigo-500/20' },
  C: { color: 'text-violet-300', ring: 'from-violet-500/20' },
  D: { color: 'text-emerald-300', ring: 'from-emerald-500/20' },
  E: { color: 'text-amber-300', ring: 'from-amber-500/20' },
  F: { color: 'text-sky-300', ring: 'from-sky-500/20' },
}

function SkillCard({ skill }: { skill: Skill }) {
  const setPendingSkillInject = useWorkbenchStore((s) => s.setPendingSkillInject)
  const toggleRightCollapsed = useWorkbenchStore((s) => s.toggleRightCollapsed)
  const isRightCollapsed = useWorkbenchStore((s) => s.isRightCollapsed)
  const group = skill.phaseGroup || 'D'
  const meta = GROUP_META[group]

  const inject = () => {
    const hint = skill.triggers[0] ? `/${skill.triggers[0].replace(/[^一-龥a-zA-Z]/g, '')} ` : ''
    setPendingSkillInject(`${hint}请使用「${skill.name}」技能：${skill.description.split('。')[0]}。`)
    if (isRightCollapsed) toggleRightCollapsed()
  }

  return (
    <motion.div
      whileHover={{ scale: 1.02, y: -2 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className={cn(
        'relative rounded-xl border border-white/10 bg-gradient-to-br to-white/[0.02] p-3 backdrop-blur-md',
        'shadow-lg shadow-black/20 hover:border-white/20 transition-colors'
      )}
      style={{ backgroundImage: `linear-gradient(135deg, ${'rgba(255,255,255,0.04)'}, transparent)` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Wrench size={13} className={meta.color} />
          <span className="text-[13px] font-medium text-foreground">{skill.name}</span>
        </div>
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full bg-white/5', meta.color)}>
          {group}·{SKILL_PHASE_GROUPS[group as keyof typeof SKILL_PHASE_GROUPS]}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
        {skill.description}
      </p>
      <button
        onClick={inject}
        className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 transition-colors"
      >
        注入对话 <ArrowRight size={11} />
      </button>
    </motion.div>
  )
}

export default function SkillPanel() {
  const grouped = useMemo(() => {
    const map: Record<string, Skill[]> = {}
    for (const s of DISK_SKILLS) {
      const g = s.phaseGroup || 'D'
      ;(map[g] ||= []).push(s)
    }
    return map
  }, [])

  const order = ['A', 'B', 'C', 'D', 'E', 'F']

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles size={15} className="text-cyan-300" />
        <h3 className="text-sm font-semibold text-foreground">AI+ 技能版图</h3>
        <span className="text-[10px] text-muted-foreground">共 {DISK_SKILLS.length} 个技能 · 六阶段</span>
      </div>

      {order.map((g) => (
        <section key={g} className="mb-5">
          <div className="mb-2 flex items-center gap-2">
            <span className={cn('text-xs font-semibold', GROUP_META[g].color)}>
              {g} · {SKILL_PHASE_GROUPS[g as keyof typeof SKILL_PHASE_GROUPS]}
            </span>
            <div className="h-px flex-1 bg-white/10" />
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {(grouped[g] || []).map((s) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
