/**
 * 统一的字数统计工具。
 * 定义“字数”为：去除空白（空格、Tab、换行）后的所有字符数（汉字、标点、英文、数字均计入）。
 * 在所有需要显示/存储字数的地方（编辑器、落盘、章节树）统一使用本函数，避免口径不一致。
 */
export function countWords(text: string): number {
  if (!text) return 0
  return text.replace(/\s/g, '').length
}
