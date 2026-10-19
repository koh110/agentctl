import os from 'node:os'
import path from 'node:path'

function numberFromEnv(value: string | undefined, fallback: number, options: { minimum?: number } = {}) {
  if (value === undefined || value === '') {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(options.minimum ?? 0, Math.floor(parsed))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(
    env.AGENTCTL_DATA_DIR ?? path.join(os.homedir(), '.local', 'state', 'agentctl')
  )

  return {
    dataDir,
    inboxDir: path.resolve(env.AGENTCTL_INBOX_DIR ?? path.join(dataDir, 'inbox')),
    statusFile: path.resolve(env.AGENTCTL_STATUS_FILE ?? path.join(dataDir, 'status.json')),
    controlPlanePath: path.resolve(env.AGENTCTL_CONTROL_PLANE_PATH ?? path.join(dataDir, 'agentctl.sqlite')),
    piDurablePath: path.resolve(env.AGENTCTL_PI_DURABLE_PATH ?? path.join(dataDir, 'pi-durable.sqlite')),
    intervalMs: numberFromEnv(env.AGENTCTL_INTERVAL_MS, 15 * 60 * 1000, { minimum: 0 }),
    maxActions: numberFromEnv(env.AGENTCTL_MAX_ACTIONS, 3, { minimum: 1 })
  }
}
