import type { Skill } from '@shared/types'

import ideaIncubate from './story-idea-incubate/skill'
import scan from './story-scan/skill'
import setup from './story-setup/skill'
import worldbuild from './story-worldbuild/skill'
import character from './story-character/skill'
import styleLab from './story-style-lab/skill'
import outlineGen from './story-outline-gen/skill'
import outlineOptimize from './story-outline-optimize/skill'
import planWorkspace from './story-plan-workspace/skill'
import goldenOpening from './story-golden-opening/skill'
import arcDesign from './story-arc-design/skill'
import template from './story-template/skill'
import longWrite from './story-long-write/skill'
import shortWrite from './story-short-write/skill'
import agentWrite from './story-agent-write/skill'
import continueWrite from './story-continue/skill'
import chapterPipeline from './story-chapter-pipeline/skill'
import revision from './story-revision/skill'
import chapterSummary from './story-chapter-summary/skill'
import summarize from './story-summarize/skill'
import snapshot from './story-snapshot/skill'
import review from './story-review/skill'
import deslop from './story-deslop/skill'
import consistency from './story-consistency/skill'
import pacing from './story-pacing/skill'
import recall from './story-recall/skill'
import importSkill from './story-import/skill'
import deconstruct from './story-deconstruct/skill'
import cover from './story-cover/skill'
import adapt from './story-adapt/skill'
import exportSkill from './story-export/skill'

export const DISK_SKILLS: Skill[] = [
  ideaIncubate,
  scan,
  setup,
  worldbuild,
  character,
  styleLab,
  outlineGen,
  outlineOptimize,
  planWorkspace,
  goldenOpening,
  arcDesign,
  template,
  longWrite,
  shortWrite,
  agentWrite,
  continueWrite,
  chapterPipeline,
  revision,
  chapterSummary,
  summarize,
  snapshot,
  review,
  deslop,
  consistency,
  pacing,
  recall,
  importSkill,
  deconstruct,
  cover,
  adapt,
  exportSkill,
]

export function getDiskSkill(id: string): Skill | undefined {
  return DISK_SKILLS.find((skill) => skill.id === id)
}

export const SKILL_PHASE_GROUPS = {
  A: '立项',
  B: '设定',
  C: '大纲',
  D: '写作',
  E: '审查',
  F: '衍生',
} as const

export default DISK_SKILLS
