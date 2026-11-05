// 小说导入服务 — 支持 txt/md 导入，自动分章+角色抽取

// 复用导出服务的 Markdown 剥离（导入简介去 MD 标记；export-service 仅依赖 data-service，无循环引用）
import { stripMarkdown } from './export-service'

export interface ImportResult {
  title: string
  description: string
  volumes: {
    title: string
    chapters: {
      title: string
      order: number
      content: string
      wordCount: number
    }[]
  }[]
  characters: {
    name: string
    role: string
    appearances: number
  }[]
  totalWordCount: number
}

// Parse .txt file content
export function parseTextFile(content: string, filename: string): ImportResult {
  const title = filename.replace(/\.(txt|md)$/, '')
  const allNames = extractCharacterNames(content)

  // Try to split by chapter markers
  const chapterPattern = /(?:第\s*[\d零一二三四五六七八九十百千]+\s*章|Chapter\s*\d+|^\s*#+\s*第.*?章)/gim
  const matches = [...content.matchAll(chapterPattern)]

  if (matches.length === 0 || matches.length === 1) {
    // Short story / no chapter markers - treat as single chapter
    return {
      title,
      description: buildDescription(content),
      volumes: [{
        title: '正文',
        chapters: [{
          title: '第一章 · 开始',
          order: 1,
          content: content.slice(0, 50000),
          wordCount: content.length,
        }],
      }],
      characters: allNames,
      totalWordCount: content.length,
    }
  }

  // Split by chapters
  const chapters: ImportResult['volumes'][0]['chapters'] = []
  for (let i = 0; i < matches.length; i++) {
    const startIdx = matches[i].index!
    const endIdx = i < matches.length - 1 ? matches[i + 1].index! : content.length
    const chapterContent = content.slice(startIdx, endIdx).trim()
    const chapterTitle = matches[i][0].replace(/^#+\s*/, '').trim()

    if (chapterContent.length > 100) {
      chapters.push({
        title: chapterTitle || `第${i + 1}章`,
        order: i + 1,
        content: chapterContent,
        wordCount: chapterContent.length,
      })
    }
  }

  // Group into volumes (every ~20 chapters)
  const CHAPTERS_PER_VOLUME = 20
  const volumes: ImportResult['volumes'] = []
  for (let i = 0; i < chapters.length; i += CHAPTERS_PER_VOLUME) {
    const volChapters = chapters.slice(i, i + CHAPTERS_PER_VOLUME)
    // 重新分配卷内序号（1, 2, 3...），覆盖全局导入序号
    volChapters.forEach((ch, idx) => { ch.order = idx + 1 })
    volumes.push({
      title: `第${Math.floor(i / CHAPTERS_PER_VOLUME) + 1}卷`,
      chapters: volChapters,
    })
  }

  return {
    title,
    description: buildDescription(content),
    volumes,
    characters: allNames,
    totalWordCount: content.length,
  }
}

// 简介取正文剥离 Markdown 后的前 200 字（先剥离再截取，避免把 `**`/`#` 等标记或半截强调对带进简介）
function buildDescription(content: string): string {
  return stripMarkdown(content).slice(0, 200).replace(/\n/g, ' ')
}

// 常见姓氏（用于候选名首字过滤）
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮下齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍卻璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'

// 复姓（仅复姓开头允许 4 字窗口，消除「知远在窗」这类贪心噪声的主要来源）
const COMPOUND_SURNAMES = '欧阳上官司马诸葛东方夏侯皇甫尉迟公孙慕容长孙宇文司徒轩辕令狐呼延端木独孤南宫万俟闻人赫连澹台公冶太叔申屠钟离鲜于司空拓跋百里西门东郭'

// 名字尾部常见的虚词/动词：修剪贪心匹配尾巴（「林知远在/林知远说」→「林知远」）
const FUNCTION_TAIL = '的了着是在说和与就也都还又被把让给对向从拿替跟朝往至到走去出入回过上下里中前后时很挺太最更再才只刚已曾经正将会要能可应该须需肯愿敢看听闻站坐卧睡吃喝唱跳飞跑冲赶追逃笑哭喊叫吵骂打架'

// 姓氏 + 频次启发式抽取（观察项修复版）：
// 1) 每个汉字串内按起点枚举窗口（普通 2-3 字，复姓 2-4 字），每个起点只取最长有效窗口，避免同名长短形式分裂计数；
// 2) 窗口尾部虚词/动词修剪后再计数；
// 3) 子串候选归并到更长超串（「林知」「知远」⊂「林知远」→ 统一计入长名），消除计数分裂。
function extractCharacterNames(text: string): { name: string; role: string; appearances: number }[] {
  const surnameSet = new Set(SURNAMES.split(''))
  const compoundSet = new Set(COMPOUND_SURNAMES.match(/.{2}/g) || [])
  const fnSet = new Set(FUNCTION_TAIL.split(''))

  const runPattern = /[\u4e00-\u9fa5]{2,}/g
  const nameCounts = new Map<string, number>()

  let match
  while ((match = runPattern.exec(text)) !== null) {
    const run = match[0]
    for (let start = 0; start < run.length - 1; start++) {
      const isCompound = compoundSet.has(run.slice(start, start + 2))
      if (!surnameSet.has(run[start]) && !isCompound) continue
      for (let len = Math.min(isCompound ? 4 : 3, run.length - start); len >= 2; len--) {
        let name = run.slice(start, start + len)
        while (name.length > 2 && fnSet.has(name[name.length - 1])) name = name.slice(0, -1)
        if (name.length < 2) continue
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1)
        break // 每个起点只取最长有效窗口
      }
    }
  }

  // 子串候选归并：被更长候选包含且长名频次达到短名一半时，计入超串。
  // （长名的每次出现都会机械地产出短子串候选，故短名频次天然 ≥ 长名频次的一半；
  //   阈值放宽到 1/2 以覆盖「全名+尾部虚词」与「正文混用短称」的场景）
  const entries = [...nameCounts.entries()]
  const mergedCounts = new Map<string, number>()
  for (const [name, count] of entries) {
    let target: string | null = null
    for (const [other, otherCount] of entries) {
      if (other.length > name.length && other.includes(name) && otherCount * 2 >= count) {
        if (!target || other.length > target.length) target = other
      }
    }
    const key = target || name
    mergedCounts.set(key, (mergedCounts.get(key) || 0) + count)
  }

  // Filter by frequency (appear at least 3 times)
  return [...mergedCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([name, count]) => ({
      name,
      role: count > 50 ? 'protagonist' : 'supporting',
      appearances: count,
    }))
}
