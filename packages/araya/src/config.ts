import os from 'node:os'
import path from 'node:path'

function numberFromEnv(
  value: string | undefined,
  fallback: number,
  options: { minimum?: number; maximum?: number } = {}
) {
  if (value === undefined || value === '') {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const bounded = Math.max(options.minimum ?? 0, Math.floor(parsed))

  return Math.min(options.maximum ?? Number.MAX_SAFE_INTEGER, bounded)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(
    env.ARAYA_DATA_DIR ?? path.join(os.homedir(), '.araya')
  )

  return {
    dataDir,
    piAgentDir: env.PI_CODING_AGENT_DIR || undefined,
    projectDir: path.resolve(env.ARAYA_PROJECT_DIR ?? process.cwd()),
    worktreeDir: path.resolve(env.ARAYA_WORKTREE_DIR ?? path.join(dataDir, 'worktrees')),
    inboxDir: path.resolve(env.ARAYA_INBOX_DIR ?? path.join(dataDir, 'inbox')),
    statusFile: path.resolve(env.ARAYA_STATUS_FILE ?? path.join(dataDir, 'status.json')),
    controlPlanePath: path.resolve(env.ARAYA_CONTROL_PLANE_PATH ?? path.join(dataDir, 'araya.sqlite')),
    piDurablePath: path.resolve(env.ARAYA_PI_DURABLE_PATH ?? path.join(dataDir, 'pi-durable.sqlite')),
    intervalMs: numberFromEnv(env.ARAYA_INTERVAL_MS, 15 * 60 * 1000, { minimum: 0 }),
    maxActions: numberFromEnv(env.ARAYA_MAX_ACTIONS, 3, { minimum: 1 }),
    developmentTimeoutMs: numberFromEnv(env.ARAYA_DEVELOPMENT_TIMEOUT_MS, 20 * 60 * 1000, {
      minimum: 1000,
      maximum: 60 * 60 * 1000
    }),
    verificationTimeoutMs: numberFromEnv(env.ARAYA_VERIFICATION_TIMEOUT_MS, 5 * 60 * 1000, {
      minimum: 1000,
      maximum: 60 * 60 * 1000
    })
  }
}
