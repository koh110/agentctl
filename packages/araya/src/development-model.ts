import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'

// 設定ファイル・worker の入力・worker の出力で共有する、開発 agent の model の規則

export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[]

// Pi に thinking level が増えて一覧から漏れると、ここが typecheck で失敗する
const THINKING_LEVELS_COVER_PI: [Exclude<ThinkingLevel, (typeof THINKING_LEVELS)[number]>] extends [never] ? true : never = true

// 設定ファイルで指定した model。thinkingLevel が null なら Pi の設定に従う
export type DevelopmentModel = {
  provider: string
  id: string
  thinkingLevel: ThinkingLevel | null
}

// worker が報告する、Pi session が実際に使う model と丸めた後の thinking level
export type SessionModel = {
  provider: string
  id: string
  thinkingLevel: ThinkingLevel
}

const MAX_MODEL_CHARS = 200
const MODEL_KEYS = 'id,provider,thinkingLevel'
// 設定できる provider と model id は、空でなく、空白（\s）と制御文字を含まない
const CONFIGURABLE_MODEL_PART_PATTERN = /^[^\s\p{Cc}]+$/u
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

export const MODEL_REFERENCE_RULE = `a "<provider>/<model id>" string of at most ${MAX_MODEL_CHARS} characters without whitespace or control characters`
export const THINKING_LEVEL_RULE = `one of ${THINKING_LEVELS.join(', ')}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasModelKeys(value: Record<string, unknown>) {
  return Object.keys(value).sort().join(',') === MODEL_KEYS
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => {
    return level === value
  })
}

// provider は最初の / より前なので / を含めない。model id は / を含めてよい
function isConfigurableModel(provider: string, id: string) {
  return !provider.includes('/') &&
    CONFIGURABLE_MODEL_PART_PATTERN.test(provider) &&
    CONFIGURABLE_MODEL_PART_PATTERN.test(id) &&
    formatModel({ provider, id }).length <= MAX_MODEL_CHARS
}

function isReportedModelPart(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_MODEL_CHARS &&
    !CONTROL_CHARACTER_PATTERN.test(value)
}

export function formatModel(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}

// `<provider>/<model id>` を最初の / で分ける。規則に合わなければ undefined を返す
export function parseModelReference(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const separator = value.indexOf('/')

  if (separator === -1) {
    return undefined
  }

  const provider = value.slice(0, separator)
  const id = value.slice(separator + 1)

  return isConfigurableModel(provider, id) ? { provider, id } : undefined
}

// worker の入力の model を、設定ファイルと同じ規則で検証する
export function parseRequestedModel(value: unknown) {
  if (value === null) {
    return null
  }

  if (!isRecord(value) || !hasModelKeys(value)) {
    throw new Error(`worker model must be null or an object with exactly these fields: ${MODEL_KEYS}`)
  }

  const { provider, id, thinkingLevel } = value

  if (typeof provider !== 'string' || typeof id !== 'string' || !isConfigurableModel(provider, id)) {
    throw new Error(`worker model must be ${MODEL_REFERENCE_RULE}`)
  }

  if (thinkingLevel !== null && !isThinkingLevel(thinkingLevel)) {
    throw new Error(`worker model thinkingLevel must be null or ${THINKING_LEVEL_RULE}`)
  }

  const model: DevelopmentModel = { provider, id, thinkingLevel }

  return model
}

// worker の出力の model を検証する。規則に合わなければ undefined を返す
export function parseSessionModel(value: unknown) {
  if (!isRecord(value) || !hasModelKeys(value)) {
    return undefined
  }

  const { provider, id, thinkingLevel } = value

  if (!isReportedModelPart(provider) || !isReportedModelPart(id) || !isThinkingLevel(thinkingLevel)) {
    return undefined
  }

  const model: SessionModel = { provider, id, thinkingLevel }

  return model
}
