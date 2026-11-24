// Offline render test for the client half.
// The web GUI needs a signed session cookie the mirrored browser cannot obtain,
// so the panel is rendered here with react-test-renderer against a fake host.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(here, 'noop.cjs'))
const React = require('react')
const { act } = require('react-test-renderer')
const TestRenderer = require('react-test-renderer')

process.env.NODE_ENV = 'test'
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PASS = []
const FAIL = []
const check = (name, ok, detail = '') => {
  if (ok) PASS.push(name)
  else FAIL.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---------------------------------------------------------------------------
// fixtures: what the host half answers
// ---------------------------------------------------------------------------
const HOME = 'C:\\Users\\14223'
const ENTRIES = [
  { name: 'Desktop', path: `${HOME}\\Desktop`, dir: true, link: false, size: 0, mtime: new Date(2026, 10, 20, 9, 30).getTime(), hidden: false, ext: '', type: '文件夹' },
  { name: 'Downloads', path: `${HOME}\\Downloads`, dir: true, link: false, size: 0, mtime: new Date(2026, 10, 21, 8, 5).getTime(), hidden: false, ext: '', type: '文件夹' },
  { name: '年度报告.docx', path: `${HOME}\\年度报告.docx`, dir: false, link: false, size: 24576, mtime: new Date(2026, 10, 19, 14, 2).getTime(), hidden: false, ext: 'docx', type: 'Word 文档' },
  { name: 'setup.exe', path: `${HOME}\\setup.exe`, dir: false, link: false, size: 1048576, mtime: new Date(2026, 10, 18, 20, 0).getTime(), hidden: false, ext: 'exe', type: '应用程序' },
]
const APPS = [
  { id: 'HKLM-64|BaiduNetdisk', name: '百度网盘', version: '7.0.1', publisher: 'Baidu', location: 'C:\\Program Files (x86)\\Baidu\\BaiduNetdisk', uninstall: 'C:\\uninst.exe', quiet: '', sizeKb: 512000, installed: '20260701', system: false, release: '', parent: '', scope: 'machine', view: 64 },
  { id: 'HKCU-64|Feishu', name: '飞书', version: '6.5.2', publisher: '北京飞书科技有限公司', location: 'C:\\Users\\14223\\AppData\\Local\\Feishu', uninstall: 'C:\\Users\\14223\\AppData\\Local\\Feishu\\uninstall.exe', quiet: '--silent', sizeKb: 0, installed: '20260315', system: false, release: '', parent: '', scope: 'user', view: 64 },
]
const opLog = []
const answer = (op, payload) => {
  switch (op) {
    case 'drives':
      return { drives: [{ name: 'C:', label: 'OS', total: 994429964288, free: 626604613632, type: 3 }] }
    case 'places':
      return { places: [{ label: '桌面', path: `${HOME}\\Desktop` }, { label: '下载', path: `${HOME}\\Downloads` }], home: HOME }
    case 'list':
      return {
        path: payload.path,
        parent: 'C:\\Users',
        volume: { name: 'C:', label: 'OS', total: 994429964288, free: 626604613632 },
        crumbs: [{ name: 'C:', path: 'C:\\' }, { name: 'Users', path: 'C:\\Users' }, { name: '14223', path: HOME }],
        entries: ENTRIES,
      }
    case 'apps':
      return { apps: APPS, total: APPS.length, userCount: 1 }
    case 'search':
      return { results: ENTRIES.filter((e) => e.name.toLowerCase().includes(String(payload.query).toLowerCase())), truncated: false, visited: 12 }
    case 'size':
      return { bytes: 377343, truncated: false }
    case 'remove':
      return { results: [{ ok: true }], failed: 0 }
    case 'mkdir':
    case 'rename':
    case 'open':
    case 'reveal':
    case 'appLaunch':
    case 'appLocation':
    case 'appUninstall':
      return { ok: true }
    default:
      throw new Error(`unexpected op: ${op}`)
  }
}

// ---------------------------------------------------------------------------
// browser stubs
// ---------------------------------------------------------------------------
const styleTags = []
const makeEl = (tag) => ({
  tagName: tag.toUpperCase(),
  attrs: {},
  textContent: '',
  setAttribute(name, value) { this.attrs[name] = value },
  remove() { const at = styleTags.indexOf(this); if (at >= 0) styleTags.splice(at, 1) },
})
const documentStub = {
  head: { appendChild: (el) => { styleTags.push(el); return el } },
  body: { appendChild: () => {} },
  createElement: (tag) => makeEl(tag),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
}
const listeners = []
const windowStub = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: (type, fn) => listeners.push([type, fn]),
  removeEventListener: () => {},
}
const storage = new Map()
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
}
const navigatorStub = { clipboard: { writeText: async () => {} } }
const fetchStub = async (_url, init) => {
  const payload = JSON.parse(init.body)
  opLog.push(payload.op)
  const data = answer(payload.op, payload)
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
}

// ---------------------------------------------------------------------------
// execute the bundle exactly as the client loader would
// ---------------------------------------------------------------------------
let registration = null
const loader = { load: (entry) => { registration = entry } }
windowStub.__ModuleLoader__ = loader

const source = readFileSync(resolve(here, '..', 'lib', 'client.js'), 'utf8')
if (!/var module = \{ exports: \{\} \}/.test(source)) {
  console.error('FATAL: the bundle no longer declares its own module/exports; the loader would throw ReferenceError.')
  process.exit(1)
}
const instrumented = source.replace(
  '    exports.apply = apply',
  '    exports.__test = { fmtSize, fmtTime, fmtInstallDate, kindOf, PanelPage, PanelIcon, FilesTab, AppsTab }\n    exports.apply = apply',
)
if (instrumented === source) {
  console.error('FATAL: could not instrument the bundle (anchor "exports.apply = apply" not found).')
  process.exit(1)
}
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'localStorage', 'navigator', 'fetch', 'console', 'setTimeout', 'clearTimeout', instrumented)(
  windowStub, documentStub, localStorageStub, navigatorStub, fetchStub, console, setTimeout, clearTimeout,
)
check('bundle registers with __ModuleLoader__', registration !== null && registration.id === 'dsh-file-app-manager', String(registration && registration.id))

const mod = registration.factory((spec) => {
  if (spec === 'react') return require('react')
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
  throw new Error(`require("${spec}") missed the module table`)
})
check('factory returns exports with apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), `inject=[${(mod.inject || []).join(',')}]`)

// ---------------------------------------------------------------------------
// apply() against a fake cordis context
// ---------------------------------------------------------------------------
const registered = []
const ctx = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  on() { return () => {} },
  get(name) { return name === 'layout' ? { selectPanel() {}, currentPanel: 'file-app-manager' } : undefined },
  slots: {
    inject(service, register) { register(); return () => {} },
    register(def, component) { registered.push({ def, component }); return () => {} },
  },
}
let disposers = []
const originalEffect = ctx.effect
ctx.effect = (fn) => { const dispose = originalEffect(fn); disposers.push(dispose); return dispose }

try {
  await act(async () => { mod.apply(ctx) })
  check('apply registers two slots without throwing', registered.length === 2, registered.map((r) => `${r.def.name}:${r.def.id ?? r.def.key}`).join(' '))
} catch (error) {
  check('apply registers two slots without throwing', false, error.stack)
}

const sidebar = registered.find((r) => r.def.name === 'sidebar.panellist')
const main = registered.find((r) => r.def.name === 'main')
check('sidebar entry keeps id and order', sidebar?.def.id === 'file-app-manager' && sidebar?.def.order === 25, JSON.stringify({ id: sidebar?.def.id, order: sidebar?.def.order }))
check('sidebar label is callable', typeof sidebar?.def.label === 'function' && sidebar.def.label() === '文件与应用', String(sidebar?.def.label?.()))
check('styles injected into <head>', styleTags.length === 1 && String(styleTags[0].textContent).includes('.fam-root'), `${styleTags.length} tag(s), ${String(styleTags[0]?.textContent || '').length} chars`)

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
const textOf = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return `${node} `
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const byClass = (root, cls) => root.findAll((node) => typeof node.type === 'string' && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(cls), { deep: true })

let renderer = null
try {
  await act(async () => { renderer = TestRenderer.create(React.createElement(main.component)) })
  await flush()
  const text = textOf(renderer.toJSON())
  check('header renders brand label', text.includes('文件与应用') && text.includes('文件') && text.includes('应用'), '')
  check('host asked for drives + places', opLog.includes('drives') && opLog.includes('places'), opLog.join(','))
  check('listing rows rendered', text.includes('Desktop') && text.includes('年度报告.docx') && text.includes('Word 文档'), '')
  check('size column formatted', text.includes('24.0 KB') && text.includes('1.00 MB'), '')
  check('time column formatted', text.includes('2026-11-19 14:02'), '')
  check('breadcrumb from host crumbs', text.includes('Users') && text.includes('14223'), '')
  check('volume usage in status bar', /C: 可用/.test(text) && text.includes('个项目'), '')
  check('places rail', text.includes('桌面') && text.includes('下载'), '')
  check('rows are real elements', byClass(renderer.root, 'fam-row').length === ENTRIES.length, `${byClass(renderer.root, 'fam-row').length} rows`)
} catch (error) {
  check('render panel', false, error.stack)
}

// context menu
try {
  const rows = byClass(renderer.root, 'fam-row')
  await act(async () => {
    rows[2].props.onContextMenu({ preventDefault() {}, clientX: 300, clientY: 200, currentTarget: { getBoundingClientRect: () => ({ left: 300, top: 200, width: 10, height: 10 }) } })
  })
  const text = textOf(renderer.toJSON())
  const labels = byClass(renderer.root, 'fam-menu-item').map((node) => textOf(node).trim())
  check('context menu opens with actions', ['打开', '在资源管理器中定位', '复制路径', '重命名', '删除'].every((label) => text.includes(label)), labels.join(' | '))
  const items = byClass(renderer.root, 'fam-menu-item')
  check('context menu items are buttons', items.length >= 5, `${items.length} items`)
  const rename = items.find((node) => textOf(node).includes('重命名'))
  await act(async () => { rename.props.onClick() })
  const dialogText = textOf(renderer.toJSON())
  check('rename dialog opens', dialogText.includes('重命名') && byClass(renderer.root, 'fam-input').length === 1, '')
} catch (error) {
  check('context menu opens with actions', false, error.stack)
}

// apps tab
try {
  const tabs = byClass(renderer.root, 'fam-tab')
  check('two tabs rendered', tabs.length === 2, `${tabs.length}`)
  await act(async () => { tabs[1].props.onClick() })
  await flush()
  const text = textOf(renderer.toJSON())
  check('apps tab fetched registry apps', opLog.includes('apps'), opLog.join(','))
  check('apps listed with version', text.includes('百度网盘') && text.includes('飞书') && text.includes('7.0.1'), '')
  check('apps show scope and publisher', text.includes('当前用户') && text.includes('北京飞书科技有限公司'), '')
  check('apps rows rendered', byClass(renderer.root, 'fam-app-row').length === APPS.length, `${byClass(renderer.root, 'fam-app-row').length}`)
  const rowButtons = byClass(renderer.root, 'fam-app-row')[0].findAll((node) => typeof node.type === 'string' && node.type === 'button', { deep: true })
  check('each app row offers actions', rowButtons.length >= 3, `${rowButtons.length} buttons`)
  await act(async () => { tabs[0].props.onClick() })
  await flush()
  check('switching back keeps the file listing', textOf(renderer.toJSON()).includes('年度报告.docx'), '')
} catch (error) {
  check('apps tab', false, error.stack)
}

// helpers
try {
  const t = mod.__test
  check('fmtSize boundaries', t.fmtSize(512) === '512 B' && t.fmtSize(1536) === '1.50 KB' && t.fmtSize(1048576) === '1.00 MB', `${t.fmtSize(512)} | ${t.fmtSize(1536)} | ${t.fmtSize(1048576)}`)
  check('fmtInstallDate', t.fmtInstallDate('20260701') === '2026-07-01', t.fmtInstallDate('20260701'))
  check('kindOf', t.kindOf('docx') === 'doc' && t.kindOf('exe') === 'exe' && t.kindOf('') === 'other', `${t.kindOf('docx')}/${t.kindOf('exe')}/${t.kindOf('')}`)
} catch (error) {
  check('helpers', false, error.stack)
}

// dispose must not leak listeners or styles
try {
  await act(async () => { for (const dispose of disposers.splice(0)) dispose() })
  check('dispose removes the injected stylesheet', styleTags.length === 0, `${styleTags.length} left`)
} catch (error) {
  check('dispose removes the injected stylesheet', false, error.stack)
}

console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
if (FAIL.length) {
  for (const item of FAIL) console.log(`  FAILED: ${item}`)
  process.exitCode = 1
}
