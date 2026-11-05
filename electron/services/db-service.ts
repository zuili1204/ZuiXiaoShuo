import Database from 'better-sqlite3'
import { join } from 'path'

let db: Database.Database | null = null

export function initDatabase(userDataPath: string) {
  const dbPath = join(userDataPath, 'zuixiaoshuo.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS novels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_path TEXT,
      genre TEXT DEFAULT '[]',
      target_platform TEXT DEFAULT '',
      status TEXT DEFAULT 'planning',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS volumes (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      volume_id TEXT NOT NULL,
      title TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      content_path TEXT DEFAULT '',
      word_count INTEGER DEFAULT 0,
      target_word_count INTEGER DEFAULT 3000,
      status TEXT DEFAULT 'draft',
      hooks TEXT DEFAULT '[]',
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (volume_id) REFERENCES volumes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT 'unknown',
      age TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      profile TEXT DEFAULT '',
      dynamic_state TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worldviews (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      category TEXT DEFAULT 'other',
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS forces (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'other',
      level TEXT DEFAULT '',
      description TEXT DEFAULT '',
      protagonist_relation TEXT DEFAULT '',
      core_members TEXT DEFAULT '',
      territory TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_forces_novel ON forces(novel_id);
  `)

  // 为旧库补充新增字段（列已存在则忽略错误）
  const characterColumns = [
    'ALTER TABLE characters ADD COLUMN gender TEXT DEFAULT \'unknown\'',
    'ALTER TABLE characters ADD COLUMN age TEXT DEFAULT \'\'',
    'ALTER TABLE characters ADD COLUMN personality TEXT DEFAULT \'\'',
    'ALTER TABLE characters ADD COLUMN appearance TEXT DEFAULT \'\'',
  ]
  for (const sql of characterColumns) {
    try { db.prepare(sql).run() } catch { /* 列已存在 */ }
  }

  // 为旧库补充 chapters.summary（列已存在则忽略错误）
  try { db.prepare('ALTER TABLE chapters ADD COLUMN summary TEXT DEFAULT \'\'').run() } catch { /* 列已存在 */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS foreshadowings (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      content TEXT NOT NULL,
      planted_chapter INTEGER,
      planned_resolve_chapter INTEGER,
      resolved_chapter INTEGER,
      status TEXT DEFAULT 'planted',
      importance TEXT DEFAULT 'minor',
      created_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 4096,
      top_p REAL,
      api_key_encrypted TEXT,
      system_prompt TEXT DEFAULT '',
      skill_refs TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT,
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  // 为旧库补充 agent_configs.top_p（IMP-08；列已存在则忽略错误）
  try { db.prepare('ALTER TABLE agent_configs ADD COLUMN top_p REAL').run() } catch { /* 列已存在 */ }

  // === P6: 导演检查点 + 角色资源账本（SQLite 权威持久化，支持断点续跑/回放） ===
  const p6Schema = `
    CREATE TABLE IF NOT EXISTS director_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      novel_id TEXT NOT NULL,
      stage_index INTEGER NOT NULL,
      agent_role TEXT NOT NULL,
      intent TEXT,
      input TEXT,
      output TEXT,
      quality_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_novel ON director_checkpoints(novel_id);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON director_checkpoints(task_id);

    CREATE TABLE IF NOT EXISTS role_ledger (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_title TEXT,
      chain_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_novel ON role_ledger(novel_id);
  `
  db.exec(p6Schema)

  // === P0：场景卡（章级 hooks 的执行层，一章 3~6 张，可单独生成/重写） ===
  const p0Schema = `
    CREATE TABLE IF NOT EXISTS scene_cards (
      id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL,
      novel_id TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      title TEXT DEFAULT '',
      goal TEXT DEFAULT '',
      obstacle TEXT DEFAULT '',
      turn TEXT DEFAULT '',
      outcome TEXT DEFAULT '',
      emotion_before TEXT DEFAULT '',
      emotion_after TEXT DEFAULT '',
      location TEXT DEFAULT '',
      story_time TEXT DEFAULT '',
      characters_json TEXT DEFAULT '[]',
      props_json TEXT DEFAULT '[]',
      hooks_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'planned',
      word_target INTEGER DEFAULT 800,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scene_cards_chapter ON scene_cards(chapter_id, order_num);
    CREATE INDEX IF NOT EXISTS idx_scene_cards_novel ON scene_cards(novel_id);
  `
  db.exec(p0Schema)

  // === P1：Story State（角色状态快照 / 时间线 / 剧情线） ===
  const p1Schema = `
    CREATE TABLE IF NOT EXISTS character_states (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_order INTEGER NOT NULL,
      location TEXT DEFAULT '',
      knowledge_json TEXT DEFAULT '{}',
      items_json TEXT DEFAULT '[]',
      abilities_json TEXT DEFAULT '[]',
      relationships_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_character_states_novel ON character_states(novel_id, chapter_order);
    CREATE INDEX IF NOT EXISTS idx_character_states_character ON character_states(character_id, chapter_order);

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_order INTEGER NOT NULL,
      story_time TEXT DEFAULT '',
      event TEXT NOT NULL,
      location TEXT DEFAULT '',
      characters_json TEXT DEFAULT '[]',
      kind TEXT DEFAULT 'plot',
      source TEXT DEFAULT 'author',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_events_novel ON timeline_events(novel_id, chapter_order);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_chapter ON timeline_events(chapter_id);

    CREATE TABLE IF NOT EXISTS plot_threads (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT DEFAULT 'foreshadow',
      status TEXT DEFAULT 'open',
      planted_chapter INTEGER,
      planned_resolve_chapter INTEGER,
      resolved_chapter INTEGER,
      urgency INTEGER DEFAULT 1,
      last_touched_chapter INTEGER,
      payoff_plan TEXT DEFAULT '',
      foreshadowing_ids_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plot_threads_novel ON plot_threads(novel_id, status);
  `
  db.exec(p1Schema)

  // === P2：文风学习与多书融合（来源 / 画像 / 锚点 / 配方 / 绑定 / 评估） ===
  const p2Schema = `
    CREATE TABLE IF NOT EXISTS style_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin_path TEXT DEFAULT '',
      chapter_count INTEGER DEFAULT 0,
      char_count INTEGER DEFAULT 0,
      content_hash TEXT DEFAULT '',
      manifest_path TEXT DEFAULT '',
      status TEXT DEFAULT 'imported',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_profiles (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft',
      confidence REAL DEFAULT 0,
      model TEXT DEFAULT '',
      prompt_version TEXT DEFAULT '',
      content_hash TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      metrics_json TEXT DEFAULT '{}',
      sample_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_style_profiles_source ON style_profiles(source_id);

    CREATE TABLE IF NOT EXISTS style_anchors (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT DEFAULT 'other',
      text TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      chapter_index INTEGER DEFAULT 0,
      quality REAL DEFAULT 0.5,
      origin TEXT DEFAULT 'excerpt',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_style_anchors_profile ON style_anchors(profile_id);

    CREATE TABLE IF NOT EXISTS style_recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      strength INTEGER DEFAULT 60,
      pov_policy TEXT DEFAULT 'follow_novel',
      pov_override_json TEXT DEFAULT 'null',
      anchor_mode TEXT DEFAULT 'excerpt',
      anchor_budget INTEGER DEFAULT 600,
      items_json TEXT DEFAULT '[]',
      overrides_json TEXT DEFAULT '{}',
      extra_rules_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS novel_style_bindings (
      novel_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      strength_override INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_eval_runs (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      chapter_hash TEXT DEFAULT '',
      style_score REAL DEFAULT 0,
      metrics_json TEXT DEFAULT '{}',
      findings_json TEXT DEFAULT '[]',
      similarity_json TEXT DEFAULT '{}',
      model TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_style_eval_chapter ON style_eval_runs(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_style_eval_novel ON style_eval_runs(novel_id, created_at);

    CREATE TABLE IF NOT EXISTS plan_eval_runs (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      field TEXT DEFAULT '',
      base_revision TEXT DEFAULT '',
      score REAL DEFAULT 0,
      blocking INTEGER DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      metrics_json TEXT DEFAULT '{}',
      findings_json TEXT DEFAULT '[]',
      model TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_eval_novel ON plan_eval_runs(novel_id, created_at);
  `
  db.exec(p2Schema)

  // === P3：评估与读者反馈（三层评估 / 读者模拟 / 作者反馈） ===
  const p3Schema = `
    CREATE TABLE IF NOT EXISTS chapter_eval_runs (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_hash TEXT DEFAULT '',
      overall_score REAL DEFAULT 0,
      deterministic_score REAL DEFAULT 0,
      model_score REAL,
      style_score REAL,
      deterministic_json TEXT DEFAULT '{}',
      model_json TEXT DEFAULT '{}',
      suggestions_json TEXT DEFAULT '[]',
      model TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_eval_chapter ON chapter_eval_runs(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_chapter_eval_novel ON chapter_eval_runs(novel_id, created_at);

    CREATE TABLE IF NOT EXISTS reader_sim_runs (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_ids_json TEXT DEFAULT '[]',
      profile_json TEXT DEFAULT '{}',
      result_json TEXT DEFAULT '{}',
      model TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reader_sim_novel ON reader_sim_runs(novel_id, created_at);

    CREATE TABLE IF NOT EXISTS chapter_feedback_notes (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      eval_run_id TEXT,
      verdict TEXT DEFAULT 'note',
      comment TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_feedback_chapter ON chapter_feedback_notes(chapter_id, created_at);
  `
  db.exec(p3Schema)

  // === P4：平台数据与发布计划（手工导入，本地存储，不托管账号、不自动发布） ===
  const p4Schema = `
    CREATE TABLE IF NOT EXISTS platform_daily_metrics (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      date TEXT NOT NULL,
      reads INTEGER DEFAULT 0,
      completion_rate REAL DEFAULT 0,
      comments INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(novel_id, platform, date)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_daily_novel ON platform_daily_metrics(novel_id, platform, date);

    CREATE TABLE IF NOT EXISTS platform_chapter_metrics (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      date TEXT DEFAULT '',
      chapter_id TEXT,
      platform_chapter_name TEXT NOT NULL,
      platform_order INTEGER DEFAULT 0,
      reads INTEGER DEFAULT 0,
      completion_rate REAL DEFAULT 0,
      comments INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(novel_id, platform, date, platform_chapter_name)
    );
    CREATE INDEX IF NOT EXISTS idx_platform_chapter_novel ON platform_chapter_metrics(novel_id, platform, platform_order);

    CREATE TABLE IF NOT EXISTS platform_chapter_mappings (
      novel_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_chapter_name TEXT NOT NULL,
      platform_order INTEGER DEFAULT 0,
      chapter_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (novel_id, platform, platform_chapter_name)
    );

    CREATE TABLE IF NOT EXISTS platform_comments (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      date TEXT DEFAULT '',
      chapter_id TEXT,
      platform_chapter_name TEXT DEFAULT '',
      content TEXT NOT NULL,
      sentiment REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_comments_novel ON platform_comments(novel_id, platform, date);

    CREATE TABLE IF NOT EXISTS publish_plans (
      id TEXT PRIMARY KEY,
      novel_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      planned_date TEXT NOT NULL,
      status TEXT DEFAULT 'planned',
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(novel_id, chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_publish_plans_novel ON publish_plans(novel_id, planned_date);
  `
  db.exec(p4Schema)

  // 系列书：在 novels 上补充分组字段（列已存在则忽略错误），不新建表
  try { db.prepare("ALTER TABLE novels ADD COLUMN series_name TEXT DEFAULT ''").run() } catch { /* 列已存在 */ }
  try { db.prepare('ALTER TABLE novels ADD COLUMN series_order INTEGER DEFAULT 0').run() } catch { /* 列已存在 */ }
  // 开书规划：全书主线独立于 outline.md 存储，避免派生视图反向成为事实源
  try { db.prepare("ALTER TABLE novels ADD COLUMN master_outline TEXT DEFAULT ''").run() } catch { /* 列已存在 */ }

  // 规划工作台：A2 分卷契约字段（旧库补列，列已存在则忽略）
  try { db.prepare("ALTER TABLE volumes ADD COLUMN goal TEXT DEFAULT ''").run() } catch { /* 列已存在 */ }
  try { db.prepare("ALTER TABLE volumes ADD COLUMN climax TEXT DEFAULT ''").run() } catch { /* 列已存在 */ }
  try { db.prepare("ALTER TABLE volumes ADD COLUMN ending_hook TEXT DEFAULT ''").run() } catch { /* 列已存在 */ }
  try { db.prepare('ALTER TABLE volumes ADD COLUMN estimated_chapters INTEGER DEFAULT 0').run() } catch { /* 列已存在 */ }
  try { db.prepare('ALTER TABLE volumes ADD COLUMN target_word_count INTEGER DEFAULT 0').run() } catch { /* 列已存在 */ }

  console.log('Database initialized at:', dbPath)
}

export function getDatabase(): Database.Database | null {
  return db
}
