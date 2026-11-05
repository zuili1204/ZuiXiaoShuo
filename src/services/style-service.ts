// P2 文风库数据层：来源 / 画像 / 锚点 / 配方 / 绑定 / 评估记录的 SQLite CRUD。
// 新表在 electron/services/db-service.ts 启动时 CREATE TABLE IF NOT EXISTS，无需迁移框架。
import type {
  NovelStyleBinding,
  StyleAnchor,
  StyleEvalResult,
  StyleEvalRun,
  StyleProfile,
  StyleProfileData,
  StyleProfileStatus,
  StyleRecipe,
  StyleSource,
  StyleSourceKind,
  StyleSourceStatus,
  StyleSampleStats,
  StyleDimensionWeights,
  StyleRecipeItem,
} from '@shared/style-types'
import { getSetting, setSetting } from './settings-service'

const api = () => window.electronAPI

const now = () => new Date().toISOString()

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ===== 来源 =====

function rowToSource(row: any): StyleSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as StyleSourceKind,
    originPath: row.origin_path ?? '',
    chapterCount: row.chapter_count ?? 0,
    charCount: row.char_count ?? 0,
    contentHash: row.content_hash ?? '',
    manifestPath: row.manifest_path ?? '',
    status: (row.status ?? 'imported') as StyleSourceStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listStyleSources(): Promise<StyleSource[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM style_sources ORDER BY updated_at DESC',
    )) as any[]
    return rows.map(rowToSource)
  } catch (e) {
    console.error('[style] list sources failed:', e)
    return []
  }
}

export async function getStyleSource(id: string): Promise<StyleSource | null> {
  try {
    const rows = (await api().db.query('SELECT * FROM style_sources WHERE id = ?', [id])) as any[]
    return rows.length ? rowToSource(rows[0]) : null
  } catch {
    return null
  }
}

export async function saveStyleSource(source: StyleSource): Promise<void> {
  await api().db.query(
    `INSERT INTO style_sources
       (id, name, kind, origin_path, chapter_count, char_count, content_hash, manifest_path, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, origin_path = excluded.origin_path,
       chapter_count = excluded.chapter_count, char_count = excluded.char_count,
       content_hash = excluded.content_hash, manifest_path = excluded.manifest_path,
       status = excluded.status, updated_at = excluded.updated_at`,
    [
      source.id,
      source.name,
      source.kind,
      source.originPath,
      source.chapterCount,
      source.charCount,
      source.contentHash,
      source.manifestPath,
      source.status,
      source.createdAt || now(),
      source.updatedAt || now(),
    ],
  )
}

export async function updateStyleSourceStatus(id: string, status: StyleSourceStatus): Promise<void> {
  await api().db.query('UPDATE style_sources SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id])
}

/** 删除来源：先删锚点/画像与磁盘语料，再删来源；引用它的配方保留（融合时跳过缺失来源）。 */
export async function deleteStyleSource(id: string): Promise<void> {
  const profiles = await listStyleProfiles(id)
  for (const profile of profiles) {
    await api().db.query('DELETE FROM style_anchors WHERE profile_id = ?', [profile.id])
  }
  await api().db.query('DELETE FROM style_profiles WHERE source_id = ?', [id])
  await api().db.query('DELETE FROM style_sources WHERE id = ?', [id])
  try {
    await api().corpus.delete(id)
  } catch (e) {
    console.warn('[style] delete corpus dir failed:', e)
  }
}

// ===== 画像 =====

function rowToProfile(row: any): StyleProfile {
  const payload = parseJson<StyleProfileData | null>(row.payload_json, null)
  return {
    id: row.id,
    sourceId: row.source_id,
    version: row.version ?? 1,
    status: (row.status ?? 'draft') as StyleProfileStatus,
    confidence: row.confidence ?? 0,
    model: row.model ?? '',
    promptVersion: row.prompt_version ?? '',
    contentHash: row.content_hash ?? '',
    payload: payload as StyleProfileData,
    metrics: parseJson<Record<string, unknown>>(row.metrics_json, {}),
    sampleStats: payload?.sampleStats ?? emptySampleStats(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function emptySampleStats(): StyleSampleStats {
  return { totalChapters: 0, sampledChapters: 0, sampledChars: 0, model: '', promptVersion: '' }
}

export async function listStyleProfiles(sourceId: string): Promise<StyleProfile[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM style_profiles WHERE source_id = ? ORDER BY version DESC',
      [sourceId],
    )) as any[]
    return rows.map(rowToProfile)
  } catch (e) {
    console.error('[style] list profiles failed:', e)
    return []
  }
}

export async function getStyleProfile(id: string): Promise<StyleProfile | null> {
  try {
    const rows = (await api().db.query('SELECT * FROM style_profiles WHERE id = ?', [id])) as any[]
    return rows.length ? rowToProfile(rows[0]) : null
  } catch {
    return null
  }
}

/** 最新 ready 画像；没有 ready 时返回最新草稿（供审阅与再分析）。 */
export async function latestStyleProfile(
  sourceId: string,
  status?: StyleProfileStatus,
): Promise<StyleProfile | null> {
  const profiles = await listStyleProfiles(sourceId)
  if (status) return profiles.find((p) => p.status === status) ?? null
  return profiles.find((p) => p.status === 'ready') ?? profiles[0] ?? null
}

export async function saveStyleProfile(profile: StyleProfile): Promise<void> {
  await api().db.query(
    `INSERT INTO style_profiles
       (id, source_id, version, status, confidence, model, prompt_version, content_hash, payload_json, metrics_json, sample_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, confidence = excluded.confidence, model = excluded.model,
       prompt_version = excluded.prompt_version, content_hash = excluded.content_hash,
       payload_json = excluded.payload_json, metrics_json = excluded.metrics_json,
       sample_json = excluded.sample_json, updated_at = excluded.updated_at`,
    [
      profile.id,
      profile.sourceId,
      profile.version,
      profile.status,
      profile.confidence,
      profile.model,
      profile.promptVersion,
      profile.contentHash,
      JSON.stringify(profile.payload),
      JSON.stringify(profile.metrics ?? {}),
      JSON.stringify({ sampleStats: profile.sampleStats }),
      profile.createdAt || now(),
      profile.updatedAt || now(),
    ],
  )
}

export async function updateStyleProfileStatus(id: string, status: StyleProfileStatus, confidence?: number): Promise<void> {
  if (confidence === undefined) {
    await api().db.query('UPDATE style_profiles SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id])
  } else {
    await api().db.query('UPDATE style_profiles SET status = ?, confidence = ?, updated_at = ? WHERE id = ?', [
      status,
      confidence,
      now(),
      id,
    ])
  }
}

/** 源文件哈希变化：把该来源所有 ready 画像标记 stale（绑定仍可用并提示）。 */
export async function markProfilesStale(sourceId: string): Promise<void> {
  await api().db.query('UPDATE style_profiles SET status = ?, updated_at = ? WHERE source_id = ? AND status = ?', [
    'stale',
    now(),
    sourceId,
    'ready',
  ])
}

// ===== 锚点 =====

function rowToAnchor(row: any): StyleAnchor {
  return {
    id: row.id,
    profileId: row.profile_id,
    kind: row.kind,
    text: row.text,
    charCount: row.char_count ?? row.text?.length ?? 0,
    chapterIndex: row.chapter_index ?? 0,
    quality: row.quality ?? 0.5,
    origin: row.origin ?? 'excerpt',
    createdAt: row.created_at,
  }
}

export async function listStyleAnchors(profileId: string): Promise<StyleAnchor[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM style_anchors WHERE profile_id = ? ORDER BY quality DESC, char_count ASC',
      [profileId],
    )) as any[]
    return rows.map(rowToAnchor)
  } catch {
    return []
  }
}

/** 重分析时整组替换锚点，避免旧证据残留。 */
export async function replaceStyleAnchors(profileId: string, anchors: StyleAnchor[]): Promise<void> {
  await api().db.query('DELETE FROM style_anchors WHERE profile_id = ?', [profileId])
  for (const anchor of anchors) {
    await api().db.query(
      `INSERT INTO style_anchors (id, profile_id, kind, text, char_count, chapter_index, quality, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        anchor.id,
        profileId,
        anchor.kind,
        anchor.text,
        anchor.charCount,
        anchor.chapterIndex,
        anchor.quality,
        anchor.origin,
        anchor.createdAt || now(),
      ],
    )
  }
}

// ===== 配方 =====

function rowToRecipe(row: any): StyleRecipe {
  const overrides = parseJson<Record<string, unknown>>(row.overrides_json, {})
  return {
    id: row.id,
    name: row.name,
    strength: row.strength ?? 60,
    povPolicy: row.pov_policy === 'follow_recipe' ? 'follow_recipe' : 'follow_novel',
    povOverride: parseJson(row.pov_override_json, null),
    anchorMode: row.anchor_mode === 'paraphrase' || row.anchor_mode === 'abstract' ? row.anchor_mode : 'excerpt',
    anchorBudget: row.anchor_budget ?? 600,
    items: parseJson<StyleRecipeItem[]>(row.items_json, []),
    dimensionWeights: (overrides.dimensionWeights as StyleDimensionWeights) ?? {},
    extraRules: parseJson<string[]>(row.extra_rules_json, []),
    overridesJson: overrides,
    status: row.status === 'ready' ? 'ready' : 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listStyleRecipes(): Promise<StyleRecipe[]> {
  try {
    const rows = (await api().db.query('SELECT * FROM style_recipes ORDER BY updated_at DESC')) as any[]
    return rows.map(rowToRecipe)
  } catch (e) {
    console.error('[style] list recipes failed:', e)
    return []
  }
}

export async function getStyleRecipe(id: string): Promise<StyleRecipe | null> {
  try {
    const rows = (await api().db.query('SELECT * FROM style_recipes WHERE id = ?', [id])) as any[]
    return rows.length ? rowToRecipe(rows[0]) : null
  } catch {
    return null
  }
}

export async function saveStyleRecipe(recipe: StyleRecipe): Promise<void> {
  await api().db.query(
    `INSERT INTO style_recipes
       (id, name, strength, pov_policy, pov_override_json, anchor_mode, anchor_budget, items_json, overrides_json, extra_rules_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, strength = excluded.strength, pov_policy = excluded.pov_policy,
       pov_override_json = excluded.pov_override_json, anchor_mode = excluded.anchor_mode,
       anchor_budget = excluded.anchor_budget, items_json = excluded.items_json,
       overrides_json = excluded.overrides_json, extra_rules_json = excluded.extra_rules_json,
       status = excluded.status, updated_at = excluded.updated_at`,
    [
      recipe.id,
      recipe.name,
      Math.max(0, Math.min(100, Math.round(recipe.strength))),
      recipe.povPolicy,
      JSON.stringify(recipe.povOverride ?? null),
      recipe.anchorMode,
      recipe.anchorBudget,
      JSON.stringify(recipe.items ?? []),
      JSON.stringify({ ...(recipe.overridesJson ?? {}), dimensionWeights: recipe.dimensionWeights ?? {} }),
      JSON.stringify(recipe.extraRules ?? []),
      recipe.status,
      recipe.createdAt || now(),
      recipe.updatedAt || now(),
    ],
  )
}

export async function deleteStyleRecipe(id: string): Promise<void> {
  await api().db.query('DELETE FROM novel_style_bindings WHERE recipe_id = ?', [id])
  await api().db.query('DELETE FROM style_recipes WHERE id = ?', [id])
}

// ===== 绑定 =====

function rowToBinding(row: any): NovelStyleBinding {
  return {
    novelId: row.novel_id,
    recipeId: row.recipe_id,
    enabled: !!row.enabled,
    strengthOverride: row.strength_override ?? null,
    updatedAt: row.updated_at,
  }
}

export async function getStyleBinding(novelId: string): Promise<NovelStyleBinding | null> {
  try {
    const rows = (await api().db.query('SELECT * FROM novel_style_bindings WHERE novel_id = ?', [novelId])) as any[]
    return rows.length ? rowToBinding(rows[0]) : null
  } catch {
    return null
  }
}

export async function saveStyleBinding(binding: NovelStyleBinding): Promise<void> {
  await api().db.query(
    `INSERT INTO novel_style_bindings (novel_id, recipe_id, enabled, strength_override, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(novel_id) DO UPDATE SET
       recipe_id = excluded.recipe_id, enabled = excluded.enabled,
       strength_override = excluded.strength_override, updated_at = excluded.updated_at`,
    [binding.novelId, binding.recipeId, binding.enabled ? 1 : 0, binding.strengthOverride ?? null, now()],
  )
}

export async function clearStyleBinding(novelId: string): Promise<void> {
  await api().db.query('DELETE FROM novel_style_bindings WHERE novel_id = ?', [novelId])
}

// ===== 评估记录 =====

function rowToEvalRun(row: any): StyleEvalRun {
  const metrics = parseJson<any>(row.metrics_json, {})
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    recipeId: row.recipe_id,
    chapterHash: row.chapter_hash ?? '',
    styleScore: row.style_score ?? 0,
    metricsScore: metrics.metricsScore ?? 0,
    rubricScore: metrics.rubricScore ?? null,
    dimensions: metrics.dimensions ?? [],
    findings: parseJson(row.findings_json, []),
    similarity: parseJson(row.similarity_json, { ngramRate: 0, longestCommon: 0, hits: [], blocking: 0, advisory: 0 }),
    ...(typeof metrics.overallScore === 'number' ? { overallScore: metrics.overallScore } : {}),
    ...(typeof metrics.craftScore === 'number' ? { craftScore: metrics.craftScore } : {}),
    ...(Array.isArray(metrics.craftDimensions) ? { craftDimensions: metrics.craftDimensions } : {}),
    ...(Array.isArray(metrics.craftFindings) ? { craftFindings: metrics.craftFindings } : {}),
    recipeName: metrics.recipeName ?? '',
    createdAt: row.created_at,
    model: row.model ?? '',
  }
}

export async function saveStyleEvalRun(run: StyleEvalRun): Promise<void> {
  await api().db.query(
    `INSERT INTO style_eval_runs
       (id, novel_id, chapter_id, recipe_id, chapter_hash, style_score, metrics_json, findings_json, similarity_json, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.novelId,
      run.chapterId,
      run.recipeId,
      run.chapterHash,
      run.styleScore,
      JSON.stringify({
        metricsScore: run.metricsScore,
        rubricScore: run.rubricScore ?? null,
        dimensions: run.dimensions,
        recipeName: run.recipeName,
        overallScore: run.overallScore ?? null,
        craftScore: run.craftScore ?? null,
        craftDimensions: run.craftDimensions ?? [],
        craftFindings: run.craftFindings ?? [],
      }),
      JSON.stringify(run.findings),
      JSON.stringify(run.similarity),
      run.model,
      run.createdAt || now(),
    ],
  )
}

export async function listStyleEvalRuns(chapterId: string, limit = 10): Promise<StyleEvalRun[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM style_eval_runs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT ?',
      [chapterId, limit],
    )) as any[]
    return rows.map(rowToEvalRun)
  } catch {
    return []
  }
}

export async function saveEvalResultAsRun(input: {
  novelId: string
  chapterId: string
  chapterHash: string
  result: StyleEvalResult
  model?: string
}): Promise<StyleEvalRun> {
  const run: StyleEvalRun = {
    ...input.result,
    id: `ser_${crypto.randomUUID()}`,
    novelId: input.novelId,
    chapterId: input.chapterId,
    chapterHash: input.chapterHash,
    model: input.model ?? '',
    createdAt: input.result.createdAt || now(),
  }
  await saveStyleEvalRun(run)
  return run
}

// ===== 设置 =====

export interface StyleDefaults {
  sampleCount: 12 | 24 | 30
  anchorMode: 'excerpt' | 'paraphrase' | 'abstract'
  agentId: string
}

const DEFAULT_STYLE_SETTINGS: StyleDefaults = { sampleCount: 24, anchorMode: 'excerpt', agentId: '' }

export async function loadStyleDefaults(): Promise<StyleDefaults> {
  try {
    const raw = await getSetting<string>('style.defaults', '')
    if (!raw) return DEFAULT_STYLE_SETTINGS
    const parsed = JSON.parse(raw) as Partial<StyleDefaults>
    return {
      sampleCount: parsed.sampleCount === 12 || parsed.sampleCount === 30 ? parsed.sampleCount : 24,
      anchorMode: parsed.anchorMode === 'paraphrase' || parsed.anchorMode === 'abstract' ? parsed.anchorMode : 'excerpt',
      agentId: typeof parsed.agentId === 'string' ? parsed.agentId : '',
    }
  } catch {
    return DEFAULT_STYLE_SETTINGS
  }
}

export async function saveStyleDefaults(defaults: Partial<StyleDefaults>): Promise<void> {
  const current = await loadStyleDefaults()
  await setSetting('style.defaults', JSON.stringify({ ...current, ...defaults }))
}

export function newStyleSourceId(): string {
  return `sty_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function newStyleRecipeId(): string {
  return `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function newStyleProfileId(): string {
  return `spf_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}
