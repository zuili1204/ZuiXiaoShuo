/**
 * IMP-04：标点统一后处理（纯函数，无副作用，便于单测与回归）
 *
 * 背景：AI 产出的同一本书里混用了三套引号——
 * 第 1–3 章 `「」`、第 4 章英文 `"`、第 5 章才用 `“”`（人工稿 30 章 2246 处全部规范，零例外）。
 *
 * 设计原则（宁可不改，不可改错）：
 * 1. 只做「零歧义」替换：`「」`/`『』` 开闭固定，直接映射；
 * 2. 英文直引号 `"` 身兼开闭，按**行内成对**判定，奇数个则整行保留原样；
 * 3. 中英文空格只处理 **中文 ↔ 英文字母**，不碰数字（否则「年10月」会被改成「年 10月」）；
 * 4. 易混词仅白名单内明确错词；
 * 5. 代码块（``` 围栏）与含 URL 的行不做引号/空格处理。
 */

/** 一键开关：出现异常时可整体关闭，回退到"原样保存"。 */
export const NORMALIZE_ENABLED = true

/**
 * 句末/句中停顿标点。用于判定「…」是「对话引号」还是「书名号/强调标记」：
 * 书名号内容通常不含标点（「校刊」「值日表」），对话则常带（「江砚！交作业的！」）。
 */
const SENTENCE_PUNCT = /[。！？，、；：!?]/

/** 易混词白名单（仅限明确错词，不做"建议级"替换） */
const TYPO_MAP: Array<[string, string]> = [
  ['做为', '作为'],
  ['意思到', '意识到'],
  ['买的起', '买得起'],
  ['暗淡无光', '黯淡无光'],
]

export interface NormalizeOptions {
  /**
   * 中英文之间补空格。**默认 false**。
   * 依据：人工稿完整 30 章实测不使用中英文空格（写「选C」「ABD的用法」「一个月2000的租金」），
   * 开启会把原稿改成另一种风格——属于"建议级美化"而非零歧义修正，故默认关闭。
   */
  addCnEnSpace?: boolean
}

export interface NormalizeResult {
  text: string
  changes: number
  details: {
    cornerQuotes: number
    straightQuotes: number
    cnEnSpaces: number
    typoFixes: number
  }
}

const isFence = (line: string) => line.trimStart().startsWith('```')
const hasUrl = (line: string) => /https?:\/\//i.test(line)

export function normalizeText(raw: string, options: NormalizeOptions = {}): NormalizeResult {
  const addCnEnSpace = options.addCnEnSpace === true
  if (!raw) return { text: raw, changes: 0, details: { cornerQuotes: 0, straightQuotes: 0, cnEnSpaces: 0, typoFixes: 0 } }

  const details = { cornerQuotes: 0, straightQuotes: 0, cnEnSpaces: 0, typoFixes: 0 }
  const lines = raw.split('\n')
  const out: string[] = []
  let inFence = false

  for (let line of lines) {
    // 代码围栏：整段原样通过
    if (isFence(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // 1) 直角引号 → 中文弯引号：
    //    仅当引号内部含句末标点时才认定为「对话引号」并转换；
    //    否则视为书名号/能力名/强调标记——人工稿《作品简介》里
    //    「系统提示」＋「每日签到」＋「好感度变化」正是此用法，必须保留。
    line = line.replace(/「([^「」]*)」/g, (m, inner: string) => {
      if (!SENTENCE_PUNCT.test(inner)) return m
      details.cornerQuotes += 2
      return `“${inner}”`
    })
    line = line.replace(/『([^『』]*)』/g, (m, inner: string) => {
      if (!SENTENCE_PUNCT.test(inner)) return m
      details.cornerQuotes += 2
      return `‘${inner}’`
    })

    // 2) 英文直引号：行内成对才转换，奇数个 = 配对不完整 → 保留原样
    if (!hasUrl(line)) {
      const cnt = (line.match(/"/g) || []).length
      if (cnt > 0 && cnt % 2 === 0) {
        let toggle = 0
        line = line.replace(/"/g, () => {
          details.straightQuotes++
          return toggle++ % 2 === 0 ? '“' : '”'
        })
      }
    }

    // 3) 中英文之间补空格（默认关闭：人工稿不使用该风格）
    if (addCnEnSpace) {
      line = line
        .replace(/([\u4e00-\u9fa5])([A-Za-z])/g, (_m, a: string, b: string) => {
          details.cnEnSpaces++
          return `${a} ${b}`
        })
        .replace(/([A-Za-z])([\u4e00-\u9fa5])/g, (_m, a: string, b: string) => {
          details.cnEnSpaces++
          return `${a} ${b}`
        })
    }

    // 4) 易混词白名单
    for (const [from, to] of TYPO_MAP) {
      if (line.includes(from)) {
        details.typoFixes += line.split(from).length - 1
        line = line.split(from).join(to)
      }
    }

    out.push(line)
  }

  const changes =
    details.cornerQuotes + details.straightQuotes + details.cnEnSpaces + details.typoFixes
  return { text: out.join('\n'), changes, details }
}
