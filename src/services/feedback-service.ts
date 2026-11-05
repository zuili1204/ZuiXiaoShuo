/**
 * P3 人工层：作者对章节评估的接受/拒绝与批注。
 * 只落本地库，不上传；不自动触发改稿。
 */
import type { ChapterFeedbackNote, FeedbackVerdict } from '@shared/review-types'

const api = () => window.electronAPI

const VERDICTS: FeedbackVerdict[] = ['accepted', 'rejected', 'note']

export const FEEDBACK_VERDICT_LABEL: Record<FeedbackVerdict, string> = {
  accepted: '接受这版',
  rejected: '需要修改',
  note: '批注',
}

function normalizeVerdict(v: unknown): FeedbackVerdict {
  return VERDICTS.includes(v as FeedbackVerdict) ? (v as FeedbackVerdict) : 'note'
}

export async function addChapterFeedback(input: {
  novelId: string
  chapterId: string
  evalRunId?: string | null
  verdict: FeedbackVerdict
  comment?: string
}): Promise<ChapterFeedbackNote> {
  const note: ChapterFeedbackNote = {
    id: `cfn_${crypto.randomUUID()}`,
    novelId: input.novelId,
    chapterId: input.chapterId,
    evalRunId: input.evalRunId ?? null,
    verdict: normalizeVerdict(input.verdict),
    comment: (input.comment ?? '').slice(0, 500),
    createdAt: new Date().toISOString(),
  }
  await api().db.query(
    `INSERT INTO chapter_feedback_notes
      (id, novel_id, chapter_id, eval_run_id, verdict, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [note.id, note.novelId, note.chapterId, note.evalRunId, note.verdict, note.comment, note.createdAt]
  )
  return note
}

export async function listChapterFeedback(
  chapterId: string,
  limit = 20
): Promise<ChapterFeedbackNote[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM chapter_feedback_notes WHERE chapter_id = ? ORDER BY created_at DESC LIMIT ?',
      [chapterId, limit]
    )) as any[]
    return rows.map((row) => ({
      id: row.id,
      novelId: row.novel_id,
      chapterId: row.chapter_id,
      evalRunId: row.eval_run_id ?? null,
      verdict: normalizeVerdict(row.verdict),
      comment: row.comment ?? '',
      createdAt: row.created_at,
    }))
  } catch (e) {
    console.error('[feedback] list failed:', e)
    return []
  }
}

export async function deleteChapterFeedback(id: string): Promise<void> {
  try {
    await api().db.query('DELETE FROM chapter_feedback_notes WHERE id = ?', [id])
  } catch (e) {
    console.error('[feedback] delete failed:', e)
  }
}
