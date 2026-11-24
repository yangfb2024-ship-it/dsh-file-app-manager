// 宿主半端的离线冒烟测试：用假的 cordis ctx 把路由挂到真 HTTP server 上，
// 逐个调用 op，检查返回结构与错误路径。不依赖 DSH 运行时。
import { createServer } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply, inject, name, ROUTES } from '../lib/index.js'

const routes = []
const ctx = {
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx, {})
console.log('plugin name/inject:', name, inject)
console.log('routes:', routes.map((r) => r.path))

const server = createServer((req, res) => {
  const route = routes.find((r) => req.url.startsWith(r.path))
  if (!route) {
    res.writeHead(404).end('no route')
    return
  }
  route.handler(req, res)
})

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const base = `http://127.0.0.1:${port}${ROUTES.rpc}`

async function call(op, payload = {}) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...payload }),
  })
  const json = await res.json()
  return json
}

function head(label, value, max = 320) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`\n## ${label}\n${text.length > max ? text.slice(0, max) + ' …' : text}`)
}

head('health', await call('health'))

const drives = await call('drives')
head('drives', drives.data?.drives)

const home = homedir()
const list = await call('list', { path: home })
console.log('\n## list home', home)
console.log('ok:', list.ok, 'entries:', list.data?.entries?.length, 'parent:', list.data?.parent)
console.log('crumbs:', JSON.stringify(list.data?.crumbs))
console.log('volume:', JSON.stringify(list.data?.volume))
console.log('first 5:', JSON.stringify(list.data?.entries?.slice(0, 5)))

const cDrive = await call('list', { path: 'C:\\' })
console.log('\n## list C:\\', cDrive.ok, cDrive.data?.entries?.length)

const bad = await call('list', { path: 'relative\\nope' })
head('list relative path (expect error)', bad)

const missing = await call('list', { path: 'C:\\__definitely_missing__' })
head('list missing (expect error)', missing)

const searchStart = Date.now()
const search = await call('search', { path: home, query: 'desktop', limit: 20 })
console.log('\n## search "desktop" in home →', search.ok, search.data?.results?.length, 'hits,', search.data?.visited, 'dirs,', Date.now() - searchStart, 'ms')

const apps = await call('apps', {})
console.log('\n## apps', apps.ok, 'total:', apps.data?.total)
const sample = (apps.data?.apps ?? []).slice(0, 6).map((app) => `${app.name} ${app.version} [${app.scope}] ${app.publisher}`)
console.log(sample.join('\n'))

const size = await call('size', { path: join(home, 'Downloads') })
head('size ~/Downloads', size)

server.close()
process.exit(0)
