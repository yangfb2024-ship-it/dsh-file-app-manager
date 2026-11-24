/**
 * dsh-file-app-manager — host half.
 *
 * 为「文件与应用管理器」面板提供数据与动作：本机文件浏览 / 新建 / 重命名 /
 * 回收站删除 / 资源管理器定位 / 递归搜索，以及从注册表 Uninstall 键读取的
 * 已安装应用清单、打开安装位置、启动、卸载。
 *
 * 只有本机（loopback）请求能进入路由：这个插件能删文件、能起进程，信任边界
 * 必须比普通只读面板更窄。路由家族：/api/dsh-file-app-manager/*。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  writeFile,
  readFile,
  unlink,
} from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'

/** Stable cordis plugin name. */
const name = 'file-app-manager'

/** Services required before the routes can mount. */
const inject = ['webServer']

/** Route family (the client bundle mirrors these literals). */
const ROUTES = {
  rpc: '/api/dsh-file-app-manager/rpc',
}

// ---------------------------------------------------------------------------
// trust fence
// ---------------------------------------------------------------------------

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = String(v4).split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Whether a socket remote address names the loopback range. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const n = address.toLowerCase()
  if (n === '::1') return true
  if (n.startsWith('::ffff:')) return isIPv4Loopback(n.slice(7))
  return isIPv4Loopback(n)
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
}

/**
 * A request may enter this plugin's routes when it came from a loopback socket
 * with a loopback Host header and browser same-origin markers. A forwarding
 * header means a proxy is in front of the host, so both the socket address and
 * the Host header describe the proxy rather than the client — refuse.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (request.headers['cf-connecting-ip'] !== undefined) return false
  if (request.headers['x-forwarded-for'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// small http helpers
// ---------------------------------------------------------------------------

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const BODY_LIMIT = 4 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// powershell bridge
// ---------------------------------------------------------------------------

const PS_EXE =
  process.env.SystemRoot !== undefined
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'

/** Escape a value for a single-quoted PowerShell literal. */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * Run a PowerShell script and return its JSON output.
 *
 * The script body must leave its payload in `$__result`; it is serialized to a
 * temp file (never through stdout, whose encoding depends on the console code
 * page — Chinese app names would be mangled) and parsed here.
 *
 * @param script - PowerShell body that assigns `$__result`.
 * @param options.input - value exposed to the script as `$__in`.
 * @param options.timeoutMs - hard limit before the process is killed.
 */
async function runPs(script, options = {}) {
  const { input, timeoutMs = 25000 } = options
  const id = randomUUID()
  const outFile = join(tmpdir(), `dsh-fam-${id}.out.json`)
  const inFile = input === undefined ? undefined : join(tmpdir(), `dsh-fam-${id}.in.json`)
  if (inFile !== undefined) await writeFile(inFile, JSON.stringify(input), 'utf8')

  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
  ]
  if (inFile !== undefined) {
    lines.push(`$__in = Get-Content -LiteralPath ${psQuote(inFile)} -Raw | ConvertFrom-Json`)
  }
  lines.push(script)
  lines.push(
    `$__json = if ($null -eq $__result) { "null" } else { $__result | ConvertTo-Json -Depth 8 -Compress }`,
  )
  lines.push(`Set-Content -LiteralPath ${psQuote(outFile)} -Value $__json -Encoding utf8`)

  try {
    const { code, stderr } = await new Promise((resolve) => {
      const child = spawn(
        PS_EXE,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          lines.join('\n'),
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let err = ''
      child.stderr?.on('data', (chunk) => {
        err += chunk.toString('utf8')
      })
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: -1, stderr: String(error?.message ?? error) })
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        resolve({ code: exitCode, stderr: err })
      })
    })

    let text
    try {
      text = await readFile(outFile, 'utf8')
    } catch {
      throw new Error(
        `PowerShell 未返回结果（退出码 ${code}）${stderr.trim() ? '：' + stderr.trim().slice(0, 400) : ''}`,
      )
    }
    const clean = text.replace(/^\uFEFF/, '').trim() || 'null'
    return JSON.parse(clean)
  } finally {
    for (const file of [outFile, inFile]) {
      if (file === undefined) continue
      unlink(file).catch(() => {})
    }
  }
}

/** Start a detached process and never wait for it. */
function detach(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...options,
  })
  child.on('error', () => {})
  child.unref()
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

/** Validate and normalize an absolute local path from the client. */
function absPath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('缺少路径参数')
  const value = input.trim()
  if (!isAbsolute(value)) throw new Error(`不是绝对路径：${value}`)
  return normalize(value)
}

/** Human-readable file type from a name (client falls back when empty). */
function typeOf(entry) {
  if (entry.dir) return '文件夹'
  const ext = extname(entry.name).toLowerCase()
  if (ext === '') return '文件'
  return ext.slice(1).toUpperCase() + ' 文件'
}

// ---------------------------------------------------------------------------
// drives
// ---------------------------------------------------------------------------

let driveCache = { at: 0, rows: [] }

async function listDrives() {
  if (Date.now() - driveCache.at < 15000 && driveCache.rows.length > 0) return driveCache.rows
  const rows = await runPs(`
$__items = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue |
  Where-Object { $_.DriveType -eq 3 -or $_.DriveType -eq 2 }
$__result = @()
foreach ($__d in $__items) {
  $__result += [pscustomobject]@{
    name  = [string]$__d.DeviceID
    label = [string]$__d.VolumeName
    total = [double]$__d.Size
    free  = [double]$__d.FreeSpace
    type  = [int]$__d.DriveType
  }
}
`)
  const list = Array.isArray(rows) ? rows : rows === null ? [] : [rows]
  driveCache = { at: Date.now(), rows: list.filter((row) => typeof row?.name === 'string') }
  return driveCache.rows
}

/** Free/total space of the volume holding `path`, or null when unknown. */
async function volumeOf(path) {
  const letter = String(path).slice(0, 2).toUpperCase()
  const drives = await listDrives()
  return drives.find((drive) => String(drive.name).toUpperCase() === letter) ?? null
}

// ---------------------------------------------------------------------------
// filesystem operations
// ---------------------------------------------------------------------------

/** Concurrent stat of directory entries, 32 at a time. */
async function statEntries(dirPath, dirents) {
  const out = []
  const batch = 32
  for (let index = 0; index < dirents.length; index += batch) {
    const slice = dirents.slice(index, index + batch)
    const rows = await Promise.all(
      slice.map(async (dirent) => {
        const full = join(dirPath, dirent.name)
        let info = null
        try {
          info = await lstat(full)
        } catch {
          info = null
        }
        const entry = {
          name: dirent.name,
          path: full,
          dir: dirent.isDirectory(),
          link: dirent.isSymbolicLink(),
          size: info?.isDirectory() ? 0 : (info?.size ?? 0),
          mtime: info?.mtimeMs != null ? Math.round(info.mtimeMs) : 0,
          hidden: dirent.name.startsWith('.') || /^(?:desktop\.ini|thumbs\.db|\$recycle\.bin|system volume information)$/i.test(dirent.name),
          ext: dirent.isDirectory() ? '' : extname(dirent.name).slice(1).toLowerCase(),
        }
        entry.type = typeOf(entry)
        return entry
      }),
    )
    out.push(...rows)
  }
  out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  return out
}

async function listDirectory(input) {
  const target = absPath(input)
  let info
  try {
    info = await stat(target)
  } catch (error) {
    throw new Error(`无法访问 ${target}：${error?.code ?? error?.message ?? '未知错误'}`)
  }
  if (!info.isDirectory()) throw new Error(`不是文件夹：${target}`)
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = await statEntries(target, dirents)
  const parent = target.replace(/[\\/]+$/, '') === '' ? null : dirname(target)
  const volume = await volumeOf(target).catch(() => null)
  return { path: target, parent, entries, volume }
}

/** Breadcrumb segments for a Windows path. */
function crumbsOf(path) {
  const parts = path.split(sep).filter((part) => part !== '')
  const out = []
  let acc = ''
  for (const part of parts) {
    acc = acc === '' ? part : acc + sep + part
    out.push({ name: part, path: acc.endsWith(sep) ? acc : acc + sep })
  }
  return out
}

const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git'])

/**
 * Breadth-first search below `root`. Bounded by wall clock, visited
 * directories and hit count so a query can never hang the panel.
 */
async function searchFiles(input, query, limit) {
  const root = absPath(input)
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') throw new Error('请输入搜索关键词')
  const max = Math.min(Math.max(Number(limit) || 200, 1), 500)
  const deadline = Date.now() + 8000
  const results = []
  const queue = [root]
  let visited = 0
  while (queue.length > 0 && results.length < max && Date.now() < deadline && visited < 6000) {
    const dir = queue.shift()
    visited += 1
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name)
      const haystack = dirent.name.toLowerCase()
      if (haystack.includes(needle)) {
        let info = null
        try {
          info = await lstat(full)
        } catch {
          info = null
        }
        results.push({
          name: dirent.name,
          path: full,
          dir: dirent.isDirectory(),
          link: dirent.isSymbolicLink(),
          size: info?.isDirectory() ? 0 : (info?.size ?? 0),
          mtime: info?.mtimeMs != null ? Math.round(info.mtimeMs) : 0,
          hidden: false,
          ext: dirent.isDirectory() ? '' : extname(dirent.name).slice(1).toLowerCase(),
          parent: dir,
        })
        if (results.length >= max) break
      }
      if (dirent.isDirectory() && !dirent.isSymbolicLink() && !SKIP_DIRS.has(haystack)) {
        queue.push(full)
      }
    }
  }
  return { results, truncated: results.length >= max || Date.now() >= deadline, visited }
}

/** Open a folder (or select an item) in Explorer. */
function revealInExplorer(target) {
  detach('explorer.exe', [`/select,${target}`])
  return { ok: true }
}

function openInExplorer(target) {
  detach('explorer.exe', [target])
  return { ok: true }
}

/** Open a file with its registered handler (ShellExecute). */
async function openWithShell(target) {
  return runPs(`
try {
  Start-Process -FilePath ${psQuote(target)} -ErrorAction Stop
  $__result = @{ ok = $true }
} catch {
  $__result = @{ ok = $false; error = $_.Exception.Message }
}
`)
}

/** Move entries to the recycle bin (recoverable, never a hard delete). */
async function moveToRecycleBin(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((item) => absPath(item))
  if (list.length === 0) throw new Error('没有选中任何项目')
  const rows = await runPs(
    `
Add-Type -AssemblyName Microsoft.VisualBasic
$__result = @()
foreach ($__p in $__in) {
  $__entry = @{ path = [string]$__p; ok = $false; error = $null }
  try {
    if (Test-Path -LiteralPath $__p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($__p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($__p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    $__entry.ok = $true
  } catch {
    $__entry.error = $_.Exception.Message
  }
  $__result += [pscustomobject]$__entry
}
`,
    { input: list, timeoutMs: 60000 },
  )
  const results = Array.isArray(rows) ? rows : rows === null ? [] : [rows]
  return { results, failed: results.filter((row) => row?.ok !== true).length }
}

/** Recursive size of a directory (bounded). */
async function directorySize(root, deadlineMs = 4000) {
  const deadline = Date.now() + deadlineMs
  let total = 0
  const stack = [root]
  while (stack.length > 0 && Date.now() < deadline) {
    const dir = stack.pop()
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (!dirent.isSymbolicLink() && !SKIP_DIRS.has(dirent.name.toLowerCase())) stack.push(full)
      } else {
        try {
          total += (await lstat(full)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { bytes: total, truncated: Date.now() >= deadline }
}

// ---------------------------------------------------------------------------
// installed applications
// ---------------------------------------------------------------------------

const REGISTRY_SCRIPT = `
$__sources = @(
  @{ hive = 'HKLM'; view = 64; path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ hive = 'HKLM'; view = 32; path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ hive = 'HKCU'; view = 64; path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$__result = @()
foreach ($__s in $__sources) {
  $__items = Get-ItemProperty -Path $__s.path -ErrorAction SilentlyContinue
  foreach ($__it in $__items) {
    if (-not $__it.DisplayName) { continue }
    $__result += [pscustomobject]@{
      id        = ($__s.hive + '-' + $__s.view + '|' + [string]$__it.PSChildName)
      hive      = $__s.hive
      view      = $__s.view
      key       = [string]$__it.PSChildName
      name      = [string]$__it.DisplayName
      version   = [string]$__it.DisplayVersion
      publisher = [string]$__it.Publisher
      location  = [string]$__it.InstallLocation
      uninstall = [string]$__it.UninstallString
      quiet     = [string]$__it.QuietUninstallString
      icon      = [string]$__it.DisplayIcon
      sizeKb    = [long]($__it.EstimatedSize)
      installed = [string]$__it.InstallDate
      system    = [int]($__it.SystemComponent)
      release   = [string]$__it.ReleaseType
      parent    = [string]$__it.ParentKeyName
    }
  }
}
`

const IGNORED_RELEASE = /^(update|hotfix|security update|servicepack|service pack)/i

let appCache = { at: 0, rows: [], byId: new Map() }

async function readApps(force) {
  if (!force && Date.now() - appCache.at < 60000 && appCache.rows.length > 0) return appCache
  const raw = await runPs(REGISTRY_SCRIPT, { timeoutMs: 40000 })
  const rows = Array.isArray(raw) ? raw : raw === null ? [] : [raw]
  const seen = new Set()
  const byId = new Map()
  const apps = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const displayName = String(row.name ?? '').trim()
    if (displayName === '') continue
    if (Number(row.system) === 1) continue
    if (String(row.parent ?? '').trim() !== '') continue
    if (IGNORED_RELEASE.test(String(row.release ?? '').trim())) continue
    const dedupe = `${displayName}|${String(row.version ?? '')}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const id = String(row.id ?? '')
    const app = {
      id,
      name: displayName,
      version: String(row.version ?? ''),
      publisher: String(row.publisher ?? ''),
      location: String(row.location ?? '').replace(/^"|"$/g, ''),
      uninstall: String(row.uninstall ?? ''),
      quiet: String(row.quiet ?? ''),
      icon: String(row.icon ?? ''),
      sizeKb: Number(row.sizeKb) || 0,
      installed: String(row.installed ?? ''),
      scope: row.hive === 'HKCU' ? 'user' : 'machine',
      view: Number(row.view) || 64,
    }
    byId.set(id, app)
    apps.push(app)
  }
  apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
  appCache = { at: Date.now(), rows: apps, byId }
  return appCache
}

/** Executable path inside a DisplayIcon value ("C:\app.exe,0" -> "C:\app.exe"). */
function iconExe(icon) {
  const value = String(icon ?? '').trim()
  if (value === '') return null
  const unquoted = value.startsWith('"') ? value.slice(1, value.lastIndexOf('"') + 1) : value.split(',')[0]
  return /\.exe$/i.test(unquoted.trim()) ? unquoted.trim() : null
}

// ---------------------------------------------------------------------------
// operation dispatch
// ---------------------------------------------------------------------------

async function dispatch(op, payload) {
  switch (op) {
    case 'drives':
      return { drives: await listDrives(), home: homedir() }
    case 'places': {
      const home = homedir()
      const candidates = [
        ['桌面', 'Desktop'],
        ['文档', 'Documents'],
        ['下载', 'Downloads'],
        ['图片', 'Pictures'],
        ['音乐', 'Music'],
        ['视频', 'Videos'],
        ['用户目录', ''],
      ]
      const places = []
      for (const [label, relative] of candidates) {
        const target = relative === '' ? home : join(home, relative)
        try {
          const info = await stat(target)
          if (info.isDirectory()) places.push({ label, path: target })
        } catch {
          /* missing profile folder: skip */
        }
      }
      return { places, home }
    }
    case 'list': {
      const listing = await listDirectory(payload.path)
      return { ...listing, crumbs: crumbsOf(listing.path) }
    }
    case 'tree': {
      // Directory-only children, for the sidebar navigation tree.
      const target = absPath(payload.path)
      const dirents = await readdir(target, { withFileTypes: true })
      const dirs = dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => ({ name: dirent.name, path: join(target, dirent.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
      return { path: target, dirs }
    }
    case 'open': {
      const target = absPath(payload.path)
      const info = await stat(target)
      if (info.isDirectory()) return { ...openInExplorer(target), external: true }
      const result = await openWithShell(target)
      if (result?.ok === false) throw new Error(result.error || '无法打开该文件')
      return { ok: true, external: true }
    }
    case 'reveal': {
      const target = absPath(payload.path)
      return revealInExplorer(target)
    }
    case 'mkdir': {
      const parent = absPath(payload.path)
      const rawName = String(payload.name ?? '').trim()
      if (rawName === '' || /[\\/:*?"<>|]/.test(rawName)) throw new Error('文件夹名不合法')
      const target = join(parent, rawName)
      await mkdir(target)
      return { path: target }
    }
    case 'rename': {
      const target = absPath(payload.path)
      const rawName = String(payload.name ?? '').trim()
      if (rawName === '' || /[\\/:*?"<>|]/.test(rawName)) throw new Error('名称不合法')
      const next = join(dirname(target), rawName)
      await access(target, FS.F_OK)
      await rename(target, next)
      return { path: next }
    }
    case 'remove':
      return moveToRecycleBin(payload.paths)
    case 'search': {
      const found = await searchFiles(payload.path, payload.query, payload.limit)
      return found
    }
    case 'size': {
      const target = absPath(payload.path)
      return directorySize(target)
    }
    case 'apps': {
      const cache = await readApps(payload.force === true)
      return {
        apps: cache.rows,
        total: cache.rows.length,
        userCount: cache.rows.filter((app) => app.scope === 'user').length,
      }
    }
    case 'appLaunch': {
      const cache = await readApps(false)
      const app = cache.byId.get(String(payload.id ?? ''))
      if (app === undefined) throw new Error('找不到该应用')
      const exe = iconExe(app.icon)
      if (exe === null) throw new Error('这个应用没有登记可执行文件，请使用「打开位置」')
      detach(exe, [])
      return { ok: true, launched: exe }
    }
    case 'appLocation': {
      const cache = await readApps(false)
      const app = cache.byId.get(String(payload.id ?? ''))
      if (app === undefined) throw new Error('找不到该应用')
      let target = app.location
      if (target === '' || target.trim() === '') {
        const exe = iconExe(app.icon)
        target = exe === null ? '' : dirname(exe)
      }
      if (target === '') throw new Error('这个应用没有登记安装位置')
      try {
        await stat(target)
      } catch {
        throw new Error(`安装位置已不存在：${target}`)
      }
      return openInExplorer(target)
    }
    case 'appUninstall': {
      const cache = await readApps(false)
      const app = cache.byId.get(String(payload.id ?? ''))
      if (app === undefined) throw new Error('找不到该应用')
      const quiet = payload.quiet === true
      let command = quiet && app.quiet !== '' ? app.quiet : app.uninstall
      if (command === '') command = app.quiet
      if (command === '') throw new Error('这个应用没有登记卸载命令')
      detach('cmd.exe', ['/c', command], { windowsHide: false })
      return { ok: true, command }
    }
    case 'health':
      return { ok: true, platform: process.platform, home: homedir() }
    default:
      throw new Error(`未知操作：${op}`)
  }
}

// ---------------------------------------------------------------------------
// cordis plugin
// ---------------------------------------------------------------------------

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: ROUTES.rpc,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          writeJson(res, 405, { error: '只接受 GET 与 POST' })
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: '文件管理接口只对本机开放' })
          return
        }
        let payload = {}
        try {
          if (req.method === 'POST') {
            const text = await readBody(req)
            payload = text.trim() === '' ? {} : JSON.parse(text)
          } else {
            const url = new URL(req.url ?? '/', 'http://localhost')
            payload = Object.fromEntries(url.searchParams.entries())
          }
          const op = String(payload.op ?? '')
          const data = await dispatch(op, payload)
          writeJson(res, 200, { ok: true, data })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
  ]
}

/**
 * Mount the file/app routes.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (`enabled: false` disables the host half).
 */
function apply(ctx, config) {
  if (config?.enabled === false) return
  const routes = makeRoutes()
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'file-app-manager: routes')
}

export { ROUTES, apply, inject, name }
