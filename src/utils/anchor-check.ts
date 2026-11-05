/**
 * 硬锚点校验（2026-10-05）。
 *
 * hooks 是 writer 的锚点合约（见 SKILL 规则 11：每个节点漏一个即重写）。
 * 本模块在正文入库前做轻量校验：从 hooks 提取必须命中的事实片段，
 * 检查正文是否覆盖。仅提示不拦截——自动判定存在误杀可能，漏命中时
 * 由作者人工复核是否需要重写。
 */

/** 提取锚点：hook 中被引号包裹的片段（台词/关键句）；无引号时取去噪后 ≥6 字的整条 hook */
export function extractAnchors(hooks: string[]): string[] {
  const anchors: string[] = []
  for (const h of hooks) {
    const quoted = [...h.matchAll(/[「『“][^」』”]{2,40}[」』”]/g)].map((m) => m[0].slice(1, -1))
    if (quoted.length) anchors.push(...quoted)
    else if (h.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').length >= 6) anchors.push(h.trim())
  }
  return [...new Set(anchors)]
}

/** 归一化：只保留汉字/字母/数字——规避台词首尾标点差异造成的误报（如「你是谁。」vs「你是谁？」） */
function norm(s: string): string {
  return s.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
}

/** 校验正文对 hooks 锚点的覆盖情况。 */
export function checkAnchors(content: string, hooks: string[]): { hit: string[]; missed: string[] } {
  if (!hooks.length) return { hit: [], missed: [] }
  const nc = norm(content)
  const hit: string[] = []
  const missed: string[] = []
  for (const a of extractAnchors(hooks)) {
    const na = norm(a)
    if (na && nc.includes(na)) hit.push(a)
    else missed.push(a)
  }
  return { hit, missed }
}
