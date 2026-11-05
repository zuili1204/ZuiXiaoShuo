// 版本更新检查（轻量级，离线安全）
// 当前版本来自主进程 app.getVersion()（经 preload 暴露），远程清单为可选。

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  releaseNotes?: string
  checkedAt: number
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

// getVersion 走 IPC（ipcRenderer.invoke），返回 Promise，必须 await
async function getCurrentVersion(): Promise<string> {
  try {
    const v = await window.electronAPI.app?.getVersion?.()
    return v || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// 通过远程清单检查更新（manifestUrl 形如 https://example.com/latest.json）
// 清单格式：{ "version": "1.2.0", "notes": "..." }
export async function checkForUpdate(manifestUrl?: string): Promise<UpdateInfo> {
  const currentVersion = await getCurrentVersion()
  if (!manifestUrl) {
    return { hasUpdate: false, currentVersion, checkedAt: Date.now() }
  }
  try {
    const resp = await fetch(manifestUrl, { method: 'GET' })
    if (!resp.ok) {
      return { hasUpdate: false, currentVersion, checkedAt: Date.now() }
    }
    const data = (await resp.json()) as { version?: string; notes?: string }
    const latest = data.version || currentVersion
    const hasUpdate = compareVersion(latest, currentVersion) > 0
    return {
      hasUpdate,
      currentVersion,
      latestVersion: latest,
      releaseNotes: data.notes,
      checkedAt: Date.now(),
    }
  } catch (e) {
    console.error('Update check failed:', e)
    return { hasUpdate: false, currentVersion, checkedAt: Date.now() }
  }
}
