// 通用设置持久化服务：读写 settings 表（key/value 文本存储）
// 让 theme / dataPath / 布局等通用配置可跨重启保留。

const api = () => window.electronAPI

export type SettingValue = string | number | boolean

interface SettingRow {
  key: string
  value: string
}

// 读取单个设置，缺省返回 fallback
export async function getSetting<T extends SettingValue = string>(
  key: string,
  fallback: T
): Promise<T> {
  try {
    const rows = await api().db.query(
      'SELECT value FROM settings WHERE key = ?',
      [key]
    ) as SettingRow[]
    if (!rows || rows.length === 0) return fallback
    return convertFromStored(rows[0].value, fallback)
  } catch (e) {
    console.error(`Failed to read setting "${key}":`, e)
    return fallback
  }
}

// 写入单个设置（UPSERT，并行安全：先查后插/更）
export async function setSetting(key: string, value: SettingValue): Promise<void> {
  const stored = typeof value === 'string' ? value : JSON.stringify(value)
  try {
    const existing = await api().db.query(
      'SELECT key FROM settings WHERE key = ?',
      [key]
    ) as SettingRow[]
    if (existing && existing.length > 0) {
      await api().db.query(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
        [stored, key]
      )
    } else {
      await api().db.query(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [key, stored]
      )
    }
  } catch (e) {
    console.error(`Failed to save setting "${key}":`, e)
  }
}

// 批量读取多个设置
export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  try {
    const placeholders = keys.map(() => '?').join(', ')
    const rows = await api().db.query(
      `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
      keys
    ) as SettingRow[]
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value
    return map
  } catch (e) {
    console.error('Failed to read settings batch:', e)
    return {}
  }
}

function convertFromStored<T extends SettingValue>(raw: string, fallback: T): T {
  if (typeof fallback === 'boolean') {
    return (raw === 'true' || raw === '1') as unknown as T
  }
  if (typeof fallback === 'number') {
    const n = Number(raw)
    return (Number.isNaN(n) ? fallback : n) as unknown as T
  }
  return raw as unknown as T
}
