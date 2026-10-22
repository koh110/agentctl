import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool
} from '@earendil-works/pi-coding-agent'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_WALK_ENTRIES = 10000
const MAX_WALK_DEPTH = 32
const MAX_GREP_OUTPUT_BYTES = 32 * 1024
const RESERVED_COMPONENTS = new Set(['.git', '.pi', 'node_modules', '.ssh', '.aws', '.gnupg'])
const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ed25519_sk'
])

function isWithinOrEqual(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)

  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function rejectParentPathComponents(inputPath: string) {
  if (inputPath.split(/[\\/]+/u).includes('..')) {
    throw new Error('workspace path cannot contain .. components')
  }
}

export function isSensitiveWorkspaceName(name: string) {
  const normalized = name.toLowerCase()

  if (SENSITIVE_FILE_NAMES.has(normalized)) {
    return true
  }

  if (normalized === '.env') {
    return true
  }

  if (normalized.startsWith('.env.')) {
    return !['.env.example', '.env.sample', '.env.template'].includes(normalized)
  }

  return false
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function validateGlob(pattern: string) {
  if (pattern.length === 0 || pattern.length > 256 || pattern.includes('\0') || path.isAbsolute(pattern)) {
    throw new Error('glob pattern must be a relative pattern of at most 256 characters')
  }

  if (pattern.split(/[\\/]+/u).includes('..')) {
    throw new Error('glob pattern cannot traverse outside the development workspace')
  }
}

function globToRegExp(pattern: string) {
  validateGlob(pattern)

  let expression = '^'

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? ''
    const nextCharacter = pattern[index + 1] ?? ''

    if (character === '*' && nextCharacter === '*') {
      const afterDoubleStar = pattern[index + 2] ?? ''

      if (afterDoubleStar === '/') {
        expression += '(?:.*/)?'
        index += 2
      } else {
        expression += '.*'
        index += 1
      }
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
    }
  }

  expression += '$'
  return new RegExp(expression, 'u')
}

function matchesAnyGlob(value: string, patterns: readonly string[]) {
  for (const pattern of patterns) {
    if (pattern.length === 0 || pattern.includes('\0')) {
      continue
    }

    try {
      if (globToRegExp(pattern).test(value)) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}

export async function createWorkspaceFileOperations(workspaceRoot: string) {
  const realRoot = await fs.realpath(workspaceRoot)
  const rootStat = await fs.lstat(realRoot)

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('development workspace root must be a real directory')
  }

  async function resolvePath(inputPath: string, allowMissing: boolean) {
    if (inputPath.length === 0 || inputPath.includes('\0')) {
      throw new Error('workspace path must be a non-empty path without NUL characters')
    }

    rejectParentPathComponents(inputPath)
    const absolutePath = path.resolve(realRoot, inputPath)

    if (!isWithinOrEqual(absolutePath, realRoot)) {
      throw new Error(`path is outside the development workspace: ${inputPath}`)
    }

    const relativePath = path.relative(realRoot, absolutePath)
    const components = relativePath.split(path.sep).filter((component) => component.length > 0)

    for (const component of components) {
      if (RESERVED_COMPONENTS.has(component.toLowerCase())) {
        throw new Error(`reserved path cannot be accessed: ${inputPath}`)
      }

      if (isSensitiveWorkspaceName(component)) {
        throw new Error(`sensitive path cannot be accessed: ${inputPath}`)
      }
    }

    let currentPath = realRoot

    for (let index = 0; index < components.length; index += 1) {
      const component = components[index] ?? ''
      currentPath = path.join(currentPath, component)
      let entryStat

      try {
        entryStat = await fs.lstat(currentPath)
      } catch (error) {
        if (allowMissing && isErrno(error, 'ENOENT')) {
          return absolutePath
        }

        throw error
      }

      if (entryStat.isSymbolicLink()) {
        throw new Error(`symbolic link path cannot be accessed: ${inputPath}`)
      }

      if (index < components.length - 1 && !entryStat.isDirectory()) {
        throw new Error(`parent path is not a directory: ${inputPath}`)
      }

      if (entryStat.isFile() && entryStat.nlink > 1) {
        throw new Error(`hard link path cannot be accessed: ${inputPath}`)
      }

      const canonicalPath = await fs.realpath(currentPath)

      if (!isWithinOrEqual(canonicalPath, realRoot)) {
        throw new Error(`resolved path is outside the development workspace: ${inputPath}`)
      }
    }

    return absolutePath
  }

  async function assertRegularFile(absolutePath: string, maximumBytes: number) {
    const handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)

    try {
      const stat = await handle.stat()

      if (!stat.isFile()) {
        throw new Error(`workspace path is not a regular file: ${absolutePath}`)
      }

      if (stat.nlink > 1) {
        throw new Error(`hard link path cannot be accessed: ${absolutePath}`)
      }

      if (stat.size > maximumBytes) {
        throw new Error(`file exceeds the ${maximumBytes} byte workspace limit: ${absolutePath}`)
      }

      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  async function ensureDirectory(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, true)
    const relativePath = path.relative(realRoot, absolutePath)
    let currentPath = realRoot

    for (const component of relativePath.split(path.sep).filter((item) => item.length > 0)) {
      currentPath = path.join(currentPath, component)

      try {
        await fs.mkdir(currentPath, { mode: 0o700 })
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw error
        }
      }

      const verifiedPath = await resolvePath(currentPath, false)
      const stat = await fs.lstat(verifiedPath)

      if (!stat.isDirectory()) {
        throw new Error(`workspace path is not a directory: ${inputPath}`)
      }
    }

    return absolutePath
  }

  async function writeFile(inputPath: string, content: string) {
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`workspace write exceeds ${MAX_WRITE_BYTES} bytes`)
    }

    const absolutePath = await resolvePath(inputPath, true)
    await ensureDirectory(path.dirname(absolutePath))

    let handle

    try {
      handle = await fs.open(
        absolutePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644
      )
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error
      }

      handle = await fs.open(absolutePath, constants.O_WRONLY | constants.O_NOFOLLOW)
    }

    try {
      const stat = await handle.stat()

      if (!stat.isFile()) {
        throw new Error(`workspace path is not a regular file: ${inputPath}`)
      }

      if (stat.nlink > 1) {
        throw new Error(`hard link path cannot be written: ${inputPath}`)
      }

      await handle.truncate(0)
      await handle.writeFile(content, { encoding: 'utf8' })
    } finally {
      await handle.close()
    }
  }

  async function listEntries(searchPath: string) {
    const absolutePath = await resolvePath(searchPath, false)
    const stat = await fs.lstat(absolutePath)

    if (stat.isFile()) {
      if (stat.nlink > 1) {
        throw new Error(`hard link path cannot be searched: ${searchPath}`)
      }

      return [{ absolutePath, relativePath: path.relative(realRoot, absolutePath).split(path.sep).join('/'), isDirectory: false }]
    }

    if (!stat.isDirectory()) {
      throw new Error(`workspace search root is not a file or directory: ${searchPath}`)
    }

    const entries: Array<{ absolutePath: string; relativePath: string; isDirectory: boolean }> = []
    const pending: Array<{ absolutePath: string; depth: number }> = [{ absolutePath, depth: 0 }]

    while (pending.length > 0) {
      const current = pending.pop()

      if (current === undefined) {
        continue
      }

      if (current.depth > MAX_WALK_DEPTH) {
        throw new Error(`workspace search exceeds the maximum depth of ${MAX_WALK_DEPTH}`)
      }

      const names = await fs.readdir(current.absolutePath)
      names.sort((left, right) => left.localeCompare(right))

      for (const name of names) {
        if (RESERVED_COMPONENTS.has(name.toLowerCase()) || isSensitiveWorkspaceName(name)) {
          continue
        }

        const childPath = path.join(current.absolutePath, name)
        const childStat = await fs.lstat(childPath)

        if (childStat.isSymbolicLink()) {
          continue
        }

        const verifiedPath = await resolvePath(childPath, false)
        const verifiedStat = await fs.lstat(verifiedPath)
        const relativePath = path.relative(realRoot, verifiedPath).split(path.sep).join('/')

        if (verifiedStat.isDirectory()) {
          entries.push({ absolutePath: verifiedPath, relativePath, isDirectory: true })
          pending.push({ absolutePath: verifiedPath, depth: current.depth + 1 })
        } else if (verifiedStat.isFile()) {
          if (verifiedStat.nlink > 1) {
            throw new Error(`hard link path cannot be searched: ${relativePath}`)
          }

          entries.push({ absolutePath: verifiedPath, relativePath, isDirectory: false })
        }

        if (entries.length > MAX_WALK_ENTRIES) {
          throw new Error(`workspace search exceeds ${MAX_WALK_ENTRIES} entries`)
        }
      }
    }

    return entries
  }

  async function readFile(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, false)
    return assertRegularFile(absolutePath, MAX_READ_BYTES)
  }

  async function readTextFile(inputPath: string) {
    const content = await readFile(inputPath)
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  }

  async function access(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, false)
    const handle = await fs.open(absolutePath, constants.O_RDWR | constants.O_NOFOLLOW)

    try {
      const stat = await handle.stat()

      if (!stat.isFile()) {
        throw new Error(`workspace path is not a regular file: ${inputPath}`)
      }

      if (stat.nlink > 1) {
        throw new Error(`hard link path cannot be accessed: ${inputPath}`)
      }
    } finally {
      await handle.close()
    }
  }

  async function exists(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, true)

    try {
      await fs.lstat(absolutePath)
      return true
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return false
      }

      throw error
    }
  }

  async function stat(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, false)
    return fs.lstat(absolutePath)
  }

  async function readdir(inputPath: string) {
    const absolutePath = await resolvePath(inputPath, false)
    const stat = await fs.lstat(absolutePath)

    if (!stat.isDirectory()) {
      throw new Error(`workspace path is not a directory: ${inputPath}`)
    }

    const names = await fs.readdir(absolutePath)
    const safeNames: string[] = []

    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      if (RESERVED_COMPONENTS.has(name.toLowerCase()) || isSensitiveWorkspaceName(name)) {
        continue
      }

      const entryPath = path.join(absolutePath, name)
      const entryStat = await fs.lstat(entryPath)

      if (!entryStat.isSymbolicLink()) {
        safeNames.push(name)
      }
    }

    return safeNames
  }

  async function glob(pattern: string, searchPath: string, options: { ignore: string[]; limit: number }) {
    const matcher = globToRegExp(pattern)
    const basePath = await resolvePath(searchPath, false)
    const candidates = await listEntries(basePath)
    const maximum = Math.min(Math.max(Math.trunc(options.limit), 1), 1000)
    const ignored = options.ignore
    const results: string[] = []

    for (const entry of candidates) {
      const relativePath = path.relative(basePath, entry.absolutePath).split(path.sep).join('/')

      if (relativePath.length === 0 || matchesAnyGlob(relativePath, ignored)) {
        continue
      }

      if (matcher.test(relativePath)) {
        results.push(relativePath)

        if (results.length >= maximum) {
          break
        }
      }
    }

    return results
  }

  async function grep(input: {
    pattern: string
    path?: string
    glob?: string
    ignoreCase?: boolean
    literal?: boolean
    context?: number
    limit?: number
  }) {
    if (input.literal === false) {
      throw new Error('regex search is disabled; use literal string search')
    }

    if (input.pattern.length === 0 || input.pattern.length > 512 || input.pattern.includes('\0')) {
      throw new Error('search pattern must contain 1 to 512 characters without NUL')
    }

    const searchRoot = input.path ?? '.'
    const candidates = await listEntries(searchRoot)
    const fileMatcher = input.glob === undefined ? undefined : globToRegExp(input.glob)
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100)
    const contextLines = Math.min(Math.max(Math.trunc(input.context ?? 0), 0), 3)
    const needle = input.ignoreCase === true ? input.pattern.toLowerCase() : input.pattern
    let totalBytes = 0
    const matches: string[] = []
    let matchLimitReached = false

    for (const entry of candidates) {
      if (entry.isDirectory) {
        continue
      }

      const relativeToSearchRoot = path.relative(path.resolve(realRoot, searchRoot), entry.absolutePath).split(path.sep).join('/')

      if (fileMatcher !== undefined && !fileMatcher.test(relativeToSearchRoot)) {
        continue
      }

      const stat = await fs.lstat(entry.absolutePath)

      if (stat.size > MAX_SEARCH_FILE_BYTES) {
        continue
      }

      totalBytes += stat.size

      if (totalBytes > MAX_SEARCH_TOTAL_BYTES) {
        throw new Error(`workspace text search exceeds ${MAX_SEARCH_TOTAL_BYTES} bytes`)
      }

      const buffer = await readFile(entry.absolutePath)

      if (buffer.includes(0)) {
        continue
      }

      let content: string

      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        continue
      }

      const lines = content.split('\n')
      const searchLines = input.ignoreCase === true ? lines.map((line) => line.toLowerCase()) : lines

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? ''

        if (!(searchLines[lineIndex] ?? '').includes(needle)) {
          continue
        }

        const first = Math.max(0, lineIndex - contextLines)
        const last = Math.min(lines.length - 1, lineIndex + contextLines)
        const snippet = lines.slice(first, last + 1).map((contextLine, offset) => {
          const number = first + offset + 1
          const marker = number === lineIndex + 1 ? '>' : ' '
          return `${marker}${number}: ${contextLine}`
        }).join('\n')

        matches.push(`${entry.relativePath}:${lineIndex + 1}\n${snippet}`)

        if (matches.length >= limit) {
          matchLimitReached = true
          break
        }
      }

      if (matchLimitReached) {
        break
      }
    }

    let output = matches.length === 0 ? 'No matches found.' : matches.join('\n\n')

    if (Buffer.byteLength(output, 'utf8') > MAX_GREP_OUTPUT_BYTES) {
      output = Buffer.from(output, 'utf8').subarray(0, MAX_GREP_OUTPUT_BYTES).toString('utf8')
      output += '\n[output truncated]'
    }

    if (matchLimitReached) {
      output += `\n[match limit ${limit} reached]`
    }

    return output
  }

  return {
    access,
    exists,
    glob,
    grep,
    listEntries,
    mkdir: ensureDirectory,
    readFile,
    readTextFile,
    readdir,
    stat,
    writeFile
  }
}

export async function createWorkspaceTools(workspaceRoot: string) {
  const operations = await createWorkspaceFileOperations(workspaceRoot)
  const readTemplate = createReadToolDefinition(workspaceRoot, {
    autoResizeImages: false,
    operations: {
      readFile: operations.readFile,
      access: operations.access,
      detectImageMimeType: async () => null
    }
  })
  const read = defineTool({
    ...readTemplate,
    name: 'araya_read',
    label: 'Read workspace file',
    description: 'Read a UTF-8 text file from the isolated development worktree.',
    executionMode: 'sequential',
    async execute(...args: Parameters<typeof readTemplate.execute>) {
      rejectParentPathComponents(args[1].path)
      return readTemplate.execute(...args)
    }
  })
  const writeTemplate = createWriteToolDefinition(workspaceRoot, {
    operations: {
      writeFile: operations.writeFile,
      mkdir: async (directory) => {
        await operations.mkdir(directory)
      }
    }
  })
  const write = defineTool({
    ...writeTemplate,
    name: 'araya_write',
    label: 'Write workspace file',
    description: 'Create or replace a UTF-8 text file inside the isolated development worktree.',
    executionMode: 'sequential',
    async execute(...args: Parameters<typeof writeTemplate.execute>) {
      rejectParentPathComponents(args[1].path)
      return writeTemplate.execute(...args)
    }
  })
  const editTemplate = createEditToolDefinition(workspaceRoot, {
    operations: {
      readFile: operations.readFile,
      writeFile: operations.writeFile,
      access: operations.access
    }
  })
  const edit = defineTool({
    ...editTemplate,
    name: 'araya_edit',
    label: 'Edit workspace file',
    description: 'Apply exact text replacements to a file inside the isolated development worktree.',
    executionMode: 'sequential',
    async execute(...args: Parameters<typeof editTemplate.execute>) {
      rejectParentPathComponents(args[1].path)
      return editTemplate.execute(...args)
    }
  })
  const lsTemplate = createLsToolDefinition(workspaceRoot, {
    operations: {
      exists: operations.exists,
      stat: operations.stat,
      readdir: operations.readdir
    }
  })
  const ls = defineTool({
    ...lsTemplate,
    name: 'araya_ls',
    label: 'List workspace files',
    description: 'List entries inside the isolated development worktree; reserved and sensitive paths are hidden.',
    executionMode: 'sequential',
    async execute(...args: Parameters<typeof lsTemplate.execute>) {
      rejectParentPathComponents(args[1].path ?? '.')
      return lsTemplate.execute(...args)
    }
  })
  const findTemplate = createFindToolDefinition(workspaceRoot, {
    operations: {
      exists: operations.exists,
      glob: operations.glob
    }
  })
  const find = defineTool({
    ...findTemplate,
    name: 'araya_find',
    label: 'Find workspace files',
    description: 'Find files by a bounded glob pattern inside the isolated development worktree.',
    executionMode: 'sequential',
    async execute(...args: Parameters<typeof findTemplate.execute>) {
      rejectParentPathComponents(args[1].path ?? '.')
      return findTemplate.execute(...args)
    }
  })
  const grepTemplate = createGrepToolDefinition(workspaceRoot)
  const grep = defineTool({
    ...grepTemplate,
    name: 'araya_grep',
    label: 'Search workspace files',
    description: 'Search for a literal text string in bounded UTF-8 files inside the isolated development worktree.',
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const output = await operations.grep(params)
      return { content: [{ type: 'text', text: output }], details: undefined }
    }
  })

  return [read, write, edit, ls, find, grep] as const
}
