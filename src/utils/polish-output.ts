/**
 * 润色（polisher / story-deslop）产出解析。
 *
 * 背景（2026-10-05 实测事故）：story-deslop 的文本模式输出 = 「去AI味润色报告 + 润色后全文」，
 * 流水线此前把整段原始输出直接存进章节正文，报告被当成小说内容。
 * 本模块负责：
 *  1. 若产出含结构化标记（<<<POLISHED-BEGIN>>>/<<<POLISHED-END>>>，SKILL.md Phase 5 协议）→ 提取标记内全文
 *  2. 否则若含「润色后全文」标题行 → 取最后一处标题之后的内容（剥离可能的代码围栏）
 *  3. 纯正文（无报告）→ 原样通过
 *  4. 报告残留混入提取结果 / 只有报告没有全文（生成被截断）/ 正文过短 → 返回 null（调用方必须拒绝入库）
 */

export interface PolishExtractResult {
  /** 提取出的纯正文 */
  text: string
  /** 原始产出是否为「报告 + 全文」格式 */
  hadReport: boolean
}

// 报告特征：出现任意一个即视为「报告残留」（非全局正则，避免 test() 的 lastIndex 状态问题）
const REPORT_RESIDUE = /去AI味润色报告|###\s*字数协议|AI味等级[:：]/
const BEGIN = '<<<POLISHED-BEGIN>>>'
const END = '<<<POLISHED-END>>>'

export function extractPolishedBody(raw: string, minLen = 200): PolishExtractResult | null {
  const input = raw ?? ''
  if (!input.trim()) return null

  let text = ''
  let hadReport = false

  if (input.includes(BEGIN) && input.includes(END)) {
    // 1) 结构化标记优先：取最后一对标记内的内容
    const pairs = input.match(/<<<POLISHED-BEGIN>>>[\s\S]*?<<<POLISHED-END>>>/g) ?? []
    const last = pairs[pairs.length - 1] ?? ''
    text = last.replace(/<<<POLISHED-BEGIN>>>|<<<POLISHED-END>>>/g, '').trim()
    hadReport = true
  } else {
    // 2) 无标记：找「润色后全文」标题行（最后一处），取其后内容
    const headings = [...input.matchAll(/^#{1,6}[^\n]*润色后全文[^\n]*$/gm)]
    if (headings.length > 0) {
      hadReport = true
      const lastHeading = headings[headings.length - 1]
      const start = (lastHeading.index ?? 0) + lastHeading[0].length
      text = input.slice(start).trim()
    } else if (REPORT_RESIDUE.test(input)) {
      // 3) 只有报告、没有全文 → 生成被截断，拒绝
      return null
    } else {
      // 4) 纯正文直接通过
      text = input.trim()
    }
  }

  if (hadReport) {
    // 剥离 markdown 代码围栏（模型常把全文包进 ``` 块）
    text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  }

  if (!text || text.length < minLen) return null
  if (REPORT_RESIDUE.test(text)) return null // 报告段落混进了提取结果
  return { text, hadReport }
}
