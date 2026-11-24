window.__ModuleLoader__.load({
  id: 'dsh-file-app-manager',
  factory: (require) => {
    // The loader calls factory(require) and takes the RETURNED value as the
    // module's exports, so the module face has to exist in this closure.
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /**
     * dsh-file-app-manager — client half.
     *
     * 一个主栏面板，两个标签页：
     *   文件 — 驱动器 / 常用位置 / 面包屑 / 列表 / 右键菜单 / 新建 / 重命名 / 回收站删除 / 搜索
     *   应用 — 注册表里登记的已安装应用：搜索、排序、打开位置、启动、卸载
     *
     * 数据全部来自宿主半端的 /api/dsh-file-app-manager/rpc（同源 fetch）。
     */
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } = React

    /** 侧栏面板 id，同时是主栏 key。 */
    const PANEL_ID = 'file-app-manager'
    /** DOCUMENT-RELATIVE：GUI 用 <base href="./">，根绝对路径会逃出子路径部署。 */
    const API_PATH = 'api/dsh-file-app-manager/rpc'
    /** 一次最多渲染多少行（超大目录靠搜索，不靠滚动）。 */
    const ROW_CAP = 1000
    const PATH_KEY = 'dsh-fam:path'

    // -----------------------------------------------------------------------
    // 宿主 API
    // -----------------------------------------------------------------------

    async function api(op, payload = {}) {
      let response
      try {
        response = await fetch(API_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, ...payload }),
        })
      } catch (error) {
        throw new Error('无法连接宿主插件：' + (error?.message ?? String(error)))
      }
      if (!response.ok) throw new Error(`宿主返回 HTTP ${response.status}`)
      let json
      try {
        json = await response.json()
      } catch {
        throw new Error('宿主返回了无法解析的内容')
      }
      if (json?.ok !== true) throw new Error(json?.error || '请求失败')
      return json.data
    }

    // -----------------------------------------------------------------------
    // 格式化
    // -----------------------------------------------------------------------

    function fmtSize(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1024) return `${n} B`
      const units = ['KB', 'MB', 'GB', 'TB', 'PB']
      let value = n / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    function fmtTime(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const date = new Date(n)
      if (Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fmtInstallDate(raw) {
      const text = String(raw ?? '').trim()
      if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
      return text
    }

    // -----------------------------------------------------------------------
    // 文件类型着色
    // -----------------------------------------------------------------------

    const KIND_GROUPS = {
      doc: ['doc', 'docx', 'rtf', 'odt', 'pdf', 'txt', 'md', 'log', 'wps', 'tex'],
      sheet: ['xls', 'xlsx', 'csv', 'et', 'ods', 'numbers'],
      slide: ['ppt', 'pptx', 'dps', 'odp', 'key'],
      image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'heic', 'tif', 'tiff', 'psd', 'raw'],
      video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'rmvb', 'mpg', 'mpeg'],
      audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'mid'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'zst', 'cab'],
      exe: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'lnk', 'appx', 'msix', 'jar'],
      code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'html', 'htm', 'css', 'scss', 'yml', 'yaml', 'toml', 'xml', 'sh', 'c', 'cpp', 'h', 'hpp', 'rs', 'go', 'java', 'sql', 'vue', 'ini', 'conf', 'env'],
      font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
    }

    const EXT_KIND = (() => {
      const table = new Map()
      for (const [kind, list] of Object.entries(KIND_GROUPS)) {
        for (const ext of list) table.set(ext, kind)
      }
      return table
    })()

    function kindOf(ext) {
      return EXT_KIND.get(String(ext ?? '').toLowerCase()) ?? 'other'
    }

    // -----------------------------------------------------------------------
    // 图标
    // -----------------------------------------------------------------------

    function Stroke({ size = 16, width = 1.8, children }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: width,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      )
    }

    const IconBack = (props) => h(Stroke, props, h('polyline', { points: '15 18 9 12 15 6' }))
    const IconUp = (props) => h(Stroke, props, h('polyline', { points: '18 15 12 9 6 15' }))
    const IconRefresh = (props) =>
      h(
        Stroke,
        props,
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.6' }),
        h('polyline', { points: '20 5 20 11 14 11' }),
      )
    const IconFolderPlus = (props) =>
      h(
        Stroke,
        props,
        h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h3.9l1.7 1.9h7.4A1.5 1.5 0 0 1 19 9.4v2' }),
        h('path', { d: 'M3 7.5v9A1.5 1.5 0 0 0 4.5 18h6' }),
        h('path', { d: 'M17 13v7M13.5 16.5h7' }),
      )
    const IconTrash = (props) =>
      h(
        Stroke,
        props,
        h('path', { d: 'M3.5 6.5h17' }),
        h('path', { d: 'M9 6.5V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8v1.7' }),
        h('path', { d: 'M6.5 6.5 7.6 19a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l1.1-12.5' }),
        h('path', { d: 'M10 10.5v5.5M14 10.5v5.5' }),
      )
    const IconSearch = (props) => h(Stroke, props, h('circle', { cx: 11, cy: 11, r: 6.5 }), h('path', { d: 'm16 16 4.5 4.5' }))
    const IconLocate = (props) =>
      h(
        Stroke,
        props,
        h('path', { d: 'M14 4h5.5v5.5' }),
        h('path', { d: 'M19.5 4 12 11.5' }),
        h('path', { d: 'M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10' }),
      )
    const IconGrid = (props) =>
      h(
        Stroke,
        props,
        h('rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.4 }),
      )
    const IconFile = (props) =>
      h(
        Stroke,
        props,
        h('path', { d: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z' }),
        h('path', { d: 'M13.5 3.5V8.5h5' }),
      )
    const IconClose = (props) => h(Stroke, props, h('path', { d: 'm6 6 12 12M18 6 6 18' }))
    const IconPlay = (props) => h(Stroke, props, h('path', { d: 'M8 5.5v13l10.5-6.5z' }))
    const IconDrive = (props) =>
      h(
        Stroke,
        props,
        h('rect', { x: 3, y: 6.5, width: 18, height: 11, rx: 2 }),
        h('path', { d: 'M3 13h18' }),
        h('circle', { cx: 7, cy: 15.5, r: 0.9, fill: 'currentColor' }),
      )

    /** 侧栏面板图标（外壳按自身尺寸与选中态渲染）。 */
    function PanelIcon({ size = 20, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3 7.4A1.4 1.4 0 0 1 4.4 6h3.8l1.7 1.9h8.7A1.4 1.4 0 0 1 20 9.3v7.3A1.4 1.4 0 0 1 18.6 18H4.4A1.4 1.4 0 0 1 3 16.6z',
          fill: active ? 'currentColor' : 'none',
          fillOpacity: active ? 0.16 : 0,
        }),
        h('path', { d: 'M6.4 12.4h9.2' }),
        h('path', { d: 'M6.4 15h5.6' }),
      )
    }

    function FolderGlyph({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.5 6.8A1.8 1.8 0 0 1 4.3 5h4.3l1.9 2.1h8A1.8 1.8 0 0 1 20.3 8.9v8.3A1.8 1.8 0 0 1 18.5 19h-14.2A1.8 1.8 0 0 1 2.5 17.2z',
          opacity: 0.9,
        }),
      )
    }

    function EntryGlyph({ entry }) {
      if (entry.dir) return h(FolderGlyph, null)
      const ext = String(entry.ext ?? '')
      const label = ext === '' ? '' : ext.slice(0, 4).toUpperCase()
      return h('span', { className: 'fam-tile', 'data-kind': kindOf(ext) }, label)
    }

    // -----------------------------------------------------------------------
    // 通用小件
    // -----------------------------------------------------------------------

    function IconButton({ title, onClick, disabled, children, label }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'fam-iconbtn',
          title,
          'aria-label': title,
          disabled: disabled === true,
          onClick,
        },
        children,
        label ? h('span', { className: 'fam-iconbtn-label' }, label) : null,
      )
    }

    function Dialog({ title, children, footer, onClose, width }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: 'fam-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'fam-dialog', style: width ? { width } : undefined, role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'fam-dialog-head' }, h('span', null, title), h(IconButton, { title: '关闭', onClick: onClose }, h(IconClose, { size: 15 }))),
          h('div', { className: 'fam-dialog-body' }, children),
          footer ? h('div', { className: 'fam-dialog-foot' }, footer) : null,
        ),
      )
    }

    function InputDialog({ title, label, initial, confirmText, onSubmit, onClose }) {
      const [value, setValue] = useState(initial ?? '')
      const ref = useRef(null)
      useEffect(() => {
        const node = ref.current
        if (node !== null) {
          node.focus()
          const dot = String(initial ?? '').lastIndexOf('.')
          if (dot > 0) node.setSelectionRange(0, dot)
          else node.select()
        }
      }, [initial])
      const submit = () => {
        const text = value.trim()
        if (text === '') return
        onSubmit(text)
      }
      return h(
        Dialog,
        {
          title,
          onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'fam-btn', onClick: onClose }, '取消'),
            h(
              'button',
              { key: 'ok', type: 'button', className: 'fam-btn', 'data-variant': 'primary', onClick: submit },
              confirmText ?? '确定',
            ),
          ],
        },
        label ? h('div', { className: 'fam-field-label' }, label) : null,
        h('input', {
          ref,
          className: 'fam-input',
          value,
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
          },
        }),
      )
    }

    function ConfirmDialog({ title, message, detail, danger, confirmText, onConfirm, onClose }) {
      return h(
        Dialog,
        {
          title,
          onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'fam-btn', onClick: onClose }, '取消'),
            h(
              'button',
              {
                key: 'ok',
                type: 'button',
                className: 'fam-btn',
                'data-variant': danger ? 'danger' : 'primary',
                onClick: onConfirm,
              },
              confirmText ?? '确定',
            ),
          ],
        },
        h('div', { className: 'fam-dialog-text' }, message),
        detail ? h('div', { className: 'fam-dialog-detail' }, detail) : null,
      )
    }

    function ContextMenu({ x, y, items, onClose }) {
      const ref = useRef(null)
      const [pos, setPos] = useState({ left: x, top: y })
      useEffect(() => {
        const node = ref.current
        if (node === null) return
        const box = node.getBoundingClientRect()
        const left = Math.min(x, window.innerWidth - box.width - 8)
        const top = Math.min(y, window.innerHeight - box.height - 8)
        setPos({ left: Math.max(8, left), top: Math.max(8, top) })
      }, [x, y])
      useEffect(() => {
        const close = () => onClose()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('mousedown', close)
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', close)
          window.removeEventListener('scroll', close, true)
          window.removeEventListener('resize', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [onClose])
      return h(
        'div',
        {
          ref,
          className: 'fam-menu',
          style: pos,
          onMouseDown: (event) => event.stopPropagation(),
          onContextMenu: (event) => event.preventDefault(),
        },
        items.map((item, index) =>
          item === '---'
            ? h('div', { key: `sep-${index}`, className: 'fam-menu-sep' })
            : h(
                'button',
                {
                  key: `${item.label}-${index}`,
                  type: 'button',
                  className: 'fam-menu-item',
                  'data-danger': item.danger === true ? '' : undefined,
                  disabled: item.disabled === true,
                  onClick: () => {
                    onClose()
                    item.run()
                  },
                },
                item.label,
                item.hint ? h('span', { className: 'fam-menu-hint' }, item.hint) : null,
              ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // 文件页
    // -----------------------------------------------------------------------

    function FilesTab({ toast }) {
      const [history, setHistory] = useState([])
      const [tick, setTick] = useState(0)
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [drives, setDrives] = useState([])
      const [places, setPlaces] = useState([])
      const [selection, setSelection] = useState([])
      const [anchor, setAnchor] = useState(-1)
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [query, setQuery] = useState('')
      const [search, setSearch] = useState(null)

      const current = history.length > 0 ? history[history.length - 1] : null

      // 首屏：驱动器 + 常用位置 + 上次停留的目录
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const [driveData, placeData] = await Promise.all([api('drives'), api('places')])
            if (!alive) return
            setDrives(Array.isArray(driveData?.drives) ? driveData.drives : [])
            setPlaces(Array.isArray(placeData?.places) ? placeData.places : [])
            let saved = null
            try {
              saved = localStorage.getItem(PATH_KEY)
            } catch {
              saved = null
            }
            setHistory([saved && saved !== '' ? saved : placeData?.home ?? driveData?.home ?? 'C:\\'])
          } catch (failure) {
            if (alive) setError(String(failure?.message ?? failure))
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      // 目录内容
      useEffect(() => {
        if (current === null) return undefined
        let alive = true
        setLoading(true)
        setError(null)
        api('list', { path: current })
          .then((data) => {
            if (!alive) return
            setListing(data)
            setSelection([])
            setAnchor(-1)
            try {
              localStorage.setItem(PATH_KEY, data.path)
            } catch {
              /* storage 不可用时忽略 */
            }
          })
          .catch((failure) => {
            if (alive) {
              setListing(null)
              setError(String(failure?.message ?? failure))
            }
          })
          .finally(() => {
            if (alive) setLoading(false)
          })
        return () => {
          alive = false
        }
      }, [current, tick])

      // 目录变化时清掉旧搜索结果
      useEffect(() => {
        setSearch(null)
      }, [current])

      const navigate = useCallback((target) => {
        setHistory((prev) => (prev[prev.length - 1] === target ? prev : [...prev, target]))
      }, [])
      const goBack = useCallback(() => {
        setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
      }, [])
      const goUp = useCallback(() => {
        setListing((data) => {
          if (data?.parent) navigate(data.parent)
          return data
        })
      }, [navigate])
      const refresh = useCallback(() => setTick((value) => value + 1), [])

      const entries = search !== null ? search.results : listing?.entries ?? []
      const visible = entries.length > ROW_CAP && search === null ? entries.slice(0, ROW_CAP) : entries

      const openEntry = useCallback(
        async (entry) => {
          if (entry.dir) {
            navigate(entry.path)
            return
          }
          try {
            await api('open', { path: entry.path })
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [navigate, toast],
      )

      const reveal = useCallback(
        async (entry) => {
          try {
            await api('reveal', { path: entry.path })
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [toast],
      )

      const openFolder = useCallback(
        async (target) => {
          try {
            await api('open', { path: target })
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [toast],
      )

      const selectRow = useCallback(
        (event, entry, index) => {
          if (event.ctrlKey || event.metaKey) {
            setSelection((prev) =>
              prev.some((item) => item.path === entry.path)
                ? prev.filter((item) => item.path !== entry.path)
                : [...prev, entry],
            )
            setAnchor(index)
            return
          }
          if (event.shiftKey && anchor >= 0) {
            const from = Math.min(anchor, index)
            const to = Math.max(anchor, index)
            setSelection(visible.slice(from, to + 1))
            return
          }
          setSelection([entry])
          setAnchor(index)
        },
        [anchor, visible],
      )

      const runSearch = useCallback(async () => {
        const text = query.trim()
        if (text === '' || current === null) {
          setSearch(null)
          return
        }
        setLoading(true)
        try {
          const data = await api('search', { path: current, query: text, limit: 300 })
          setSearch({ query: text, root: current, results: data.results ?? [], truncated: data.truncated === true })
          setSelection([])
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error')
        } finally {
          setLoading(false)
        }
      }, [current, query, toast])

      const clearSearch = useCallback(() => {
        setSearch(null)
        setQuery('')
      }, [])

      const removeSelection = useCallback(async () => {
        const items = selection
        if (items.length === 0) return
        try {
          const result = await api('remove', { paths: items.map((item) => item.path) })
          const failed = Number(result?.failed ?? 0)
          if (failed > 0) {
            const first = (result.results ?? []).find((row) => row?.ok !== true)
            toast(`有 ${failed} 项未能删除：${first?.error ?? '未知原因'}`, 'error')
          } else {
            toast(`已移到回收站：${items.length} 项`)
          }
          setDialog(null)
          refresh()
        } catch (failure) {
          toast(String(failure?.message ?? failure), 'error')
          setDialog(null)
        }
      }, [refresh, selection, toast])

      const doRename = useCallback(
        async (target, name) => {
          try {
            await api('rename', { path: target, name })
            setDialog(null)
            toast('已重命名')
            refresh()
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [refresh, toast],
      )

      const doCreate = useCallback(
        async (name) => {
          if (current === null) return
          try {
            await api('mkdir', { path: current, name })
            setDialog(null)
            toast(`已新建文件夹：${name}`)
            refresh()
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [current, refresh, toast],
      )

      const copyPaths = useCallback(async () => {
        const text = selection.map((item) => item.path).join('\n')
        try {
          await navigator.clipboard.writeText(text)
          toast('路径已复制')
        } catch {
          toast('浏览器拒绝了剪贴板写入', 'error')
        }
      }, [selection, toast])

      const measure = useCallback(
        async (entry) => {
          toast(`正在统计 ${entry.name} 的大小…`)
          try {
            const data = await api('size', { path: entry.path })
            toast(`${entry.name}：${fmtSize(data.bytes)}${data.truncated ? '（已超时，为下限）' : ''}`)
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          }
        },
        [toast],
      )

      const rowMenu = useCallback(
        (event, entry, index) => {
          event.preventDefault()
          const items = [entry, ...selection.filter((item) => item.path !== entry.path)]
          if (!selection.some((item) => item.path === entry.path)) setSelection(items)
          setAnchor(index)
          setMenu({ x: event.clientX, y: event.clientY, entry })
        },
        [selection],
      )

      const volume = listing?.volume ?? null
      const crumbs = search !== null ? [{ name: '搜索结果', path: search.root }] : listing?.crumbs ?? []

      return h(
        'div',
        { className: 'fam-split' },
        // ---- 左栏：驱动器与常用位置 ----
        h(
          'aside',
          { className: 'fam-side' },
          h('div', { className: 'fam-side-label' }, '常用位置'),
          ...places.map((place) =>
            h(
              'button',
              {
                key: place.path,
                type: 'button',
                className: 'fam-side-item',
                'data-active': current === place.path ? '' : undefined,
                onClick: () => navigate(place.path),
              },
              h('span', { className: 'fam-side-glyph' }, h(FolderGlyph, { size: 15 })),
              h('span', { className: 'fam-side-name' }, place.label),
            ),
          ),
          h('div', { className: 'fam-side-label', style: { marginTop: 10 } }, '此电脑'),
          ...drives.map((drive) =>
            h(
              'button',
              {
                key: drive.name,
                type: 'button',
                className: 'fam-side-drive',
                'data-active': String(current ?? '').toUpperCase().startsWith(String(drive.name).toUpperCase()) ? '' : undefined,
                onClick: () => navigate(`${drive.name}\\`),
              },
              h('span', { className: 'fam-side-glyph' }, h(IconDrive, { size: 15 })),
              h(
                'span',
                { className: 'fam-side-name' },
                `${drive.name}${drive.label ? ' ' + drive.label : ''}`,
                h(
                  'span',
                  { className: 'fam-bar' },
                  h('span', {
                    className: 'fam-bar-fill',
                    style: { width: `${drive.total > 0 ? Math.max(2, Math.min(100, ((drive.total - drive.free) / drive.total) * 100)) : 0}%` },
                  }),
                ),
                h('span', { className: 'fam-side-sub' }, `${fmtSize(drive.free)} 可用`),
              ),
            ),
          ),
        ),
        // ---- 右栏：工具栏 + 面包屑 + 列表 ----
        h(
          'section',
          { className: 'fam-main' },
          h(
            'div',
            { className: 'fam-toolbar' },
            h(IconButton, { title: '后退', onClick: goBack, disabled: history.length < 2 }, h(IconBack, null)),
            h(IconButton, { title: '上一级', onClick: goUp, disabled: !listing?.parent }, h(IconUp, null)),
            h(IconButton, { title: '刷新', onClick: refresh }, h(IconRefresh, null)),
            h('div', { className: 'fam-toolbar-sep' }),
            h(IconButton, { title: '新建文件夹', onClick: () => setDialog({ kind: 'create' }) }, h(IconFolderPlus, null)),
            h(
              IconButton,
              { title: '删除（移到回收站）', onClick: () => setDialog({ kind: 'delete' }), disabled: selection.length === 0 },
              h(IconTrash, null),
            ),
            h(
              IconButton,
              { title: '在资源管理器中打开当前文件夹', onClick: () => current && openFolder(current), disabled: current === null },
              h(IconLocate, null),
            ),
            h(
              'div',
              { className: 'fam-search' },
              h(IconSearch, { size: 14 }),
              h('input', {
                className: 'fam-search-input',
                placeholder: `在 ${search !== null ? search.root : current ?? ''} 中搜索`,
                value: query,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') runSearch()
                  if (event.key === 'Escape') clearSearch()
                },
              }),
              search !== null
                ? h(IconButton, { title: '清除搜索', onClick: clearSearch }, h(IconClose, { size: 13 }))
                : null,
            ),
          ),
          h(
            'div',
            { className: 'fam-crumbs' },
            ...crumbs.map((crumb, index) =>
              h(
                'span',
                { key: `${crumb.path}-${index}`, className: 'fam-crumb-wrap' },
                h('button', { type: 'button', className: 'fam-crumb', onClick: () => navigate(crumb.path) }, crumb.name),
                index < crumbs.length - 1 ? h('span', { className: 'fam-crumb-sep' }, '›') : null,
              ),
            ),
            search !== null
              ? h('span', { className: 'fam-crumb-tag' }, `搜索 “${search.query}”`)
              : null,
          ),
          h(
            'div',
            { className: 'fam-thead' },
            h('div', { className: 'fam-col-name' }, '名称'),
            h('div', { className: 'fam-col-time' }, search !== null ? '所在位置' : '修改日期'),
            h('div', { className: 'fam-col-type' }, '类型'),
            h('div', { className: 'fam-col-size' }, '大小'),
          ),
          h(
            'div',
            { className: 'fam-list', onClick: (event) => {
              if (event.target === event.currentTarget) setSelection([])
            } },
            loading && visible.length === 0
              ? h('div', { className: 'fam-state' }, '正在读取…')
              : error !== null
                ? h(
                    'div',
                    { className: 'fam-state', 'data-tone': 'error' },
                    error,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'fam-btn',
                        style: { marginTop: 10 },
                        onClick: () => {
                          setError(null)
                          setHistory([places[0]?.path ?? 'C:\\'])
                        },
                      },
                      '回到用户目录',
                    ),
                  )
                : visible.length === 0
                  ? h('div', { className: 'fam-state' }, search !== null ? '没有匹配的项目' : '这个文件夹是空的')
                  : visible.map((entry, index) =>
                      h(
                        'div',
                        {
                          key: entry.path,
                          className: 'fam-row',
                          'data-selected': selection.some((item) => item.path === entry.path) ? '' : undefined,
                          'data-dir': entry.dir ? '' : undefined,
                          'data-dim': entry.hidden ? '' : undefined,
                          onClick: (event) => selectRow(event, entry, index),
                          onDoubleClick: () => openEntry(entry),
                          onContextMenu: (event) => rowMenu(event, entry, index),
                          title: entry.path,
                        },
                        h(
                          'div',
                          { className: 'fam-col-name' },
                          h('span', { className: 'fam-row-glyph' }, h(EntryGlyph, { entry })),
                          h('span', { className: 'fam-row-name' }, entry.name),
                        ),
                        h(
                          'div',
                          { className: 'fam-col-time fam-muted' },
                          search !== null ? entry.parent ?? '' : fmtTime(entry.mtime),
                        ),
                        h('div', { className: 'fam-col-type fam-muted' }, entry.type ?? ''),
                        h('div', { className: 'fam-col-size fam-muted' }, entry.dir ? '' : fmtSize(entry.size)),
                      ),
                    ),
            visible.length >= ROW_CAP && search === null
              ? h('div', { className: 'fam-note' }, `仅显示前 ${ROW_CAP} 项，请用搜索定位其余项目`)
              : null,
          ),
          h(
            'div',
            { className: 'fam-status' },
            h('span', null, `${visible.length} 个项目${entries.length > visible.length ? `（共 ${entries.length}）` : ''}`),
            selection.length > 0 ? h('span', null, `已选 ${selection.length} 项`) : null,
            search !== null && search.truncated ? h('span', null, '结果已截断') : null,
            volume !== null ? h('span', null, `${volume.name} 可用 ${fmtSize(volume.free)} / ${fmtSize(volume.total)}`) : null,
          ),
        ),
        menu !== null
          ? h(ContextMenu, {
              x: menu.x,
              y: menu.y,
              onClose: () => setMenu(null),
              items: [
                { label: '打开', run: () => openEntry(menu.entry) },
                { label: '在资源管理器中定位', run: () => reveal(menu.entry) },
                menu.entry.dir ? { label: '在资源管理器中打开', run: () => openFolder(menu.entry.path) } : '---',
                selection.length > 1 ? { label: `复制路径（${selection.length} 项）`, run: copyPaths } : { label: '复制路径', run: copyPaths },
                menu.entry.dir ? { label: '统计文件夹大小', run: () => measure(menu.entry) } : '---',
                {
                  label: '重命名…',
                  disabled: selection.length > 1,
                  run: () => setDialog({ kind: 'rename', path: menu.entry.path, name: menu.entry.name }),
                },
                {
                  label: selection.length > 1 ? `删除 ${selection.length} 项（回收站）` : '删除（回收站）',
                  danger: true,
                  run: () => setDialog({ kind: 'delete' }),
                },
              ],
            })
          : null,
        dialog !== null && dialog.kind === 'create'
          ? h(InputDialog, {
              title: '新建文件夹',
              label: '文件夹名称',
              initial: '新建文件夹',
              confirmText: '创建',
              onSubmit: doCreate,
              onClose: () => setDialog(null),
            })
          : null,
        dialog !== null && dialog.kind === 'rename'
          ? h(InputDialog, {
              title: '重命名',
              label: '新名称',
              initial: dialog.name,
              confirmText: '重命名',
              onSubmit: (name) => doRename(dialog.path, name),
              onClose: () => setDialog(null),
            })
          : null,
        dialog !== null && dialog.kind === 'delete'
          ? h(ConfirmDialog, {
              title: '移到回收站',
              message: selection.length === 1 ? `确定要删除「${selection[0].name}」吗？` : `确定要删除选中的 ${selection.length} 个项目吗？`,
              detail: '项目会进入回收站，可以从回收站还原。',
              danger: true,
              confirmText: '移到回收站',
              onConfirm: removeSelection,
              onClose: () => setDialog(null),
            })
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // 应用页
    // -----------------------------------------------------------------------

    function scopeLabel(app) {
      if (app.scope === 'user') return '当前用户'
      return app.view === 32 ? '系统 · 32 位' : '系统'
    }

    function AppsTab({ toast }) {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [scope, setScope] = useState('all')
      const [sort, setSort] = useState('name')
      const [dialog, setDialog] = useState(null)
      const [busyId, setBusyId] = useState(null)

      const load = useCallback(
        async (force) => {
          setLoading(true)
          setError(null)
          try {
            const result = await api('apps', { force: force === true })
            setData(result)
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setLoading(false)
          }
        },
        [],
      )

      useEffect(() => {
        load(false)
      }, [load])

      const apps = Array.isArray(data?.apps) ? data.apps : []

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const list = apps.filter((app) => {
          if (scope !== 'all' && app.scope !== scope) return false
          if (needle === '') return true
          return (
            app.name.toLowerCase().includes(needle) ||
            String(app.publisher ?? '').toLowerCase().includes(needle) ||
            String(app.version ?? '').toLowerCase().includes(needle)
          )
        })
        const sorted = [...list]
        sorted.sort((a, b) => {
          if (sort === 'size') return (b.sizeKb ?? 0) - (a.sizeKb ?? 0)
          if (sort === 'publisher') return String(a.publisher).localeCompare(String(b.publisher), 'zh-Hans-CN')
          if (sort === 'installed') return String(b.installed ?? '').localeCompare(String(a.installed ?? ''))
          return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
        })
        return sorted
      }, [apps, query, scope, sort])

      const act = useCallback(
        async (id, run, message) => {
          setBusyId(id)
          try {
            await run()
            if (message) toast(message)
          } catch (failure) {
            toast(String(failure?.message ?? failure), 'error')
          } finally {
            setBusyId(null)
          }
        },
        [toast],
      )

      const launch = (app) =>
        act(app.id, () => api('appLaunch', { id: app.id }), `已启动 ${app.name}`)
      const locate = (app) => act(app.id, () => api('appLocation', { id: app.id }), `已打开 ${app.name} 的安装位置`)

      return h(
        'div',
        { className: 'fam-apps' },
        h(
          'div',
          { className: 'fam-toolbar' },
          h(
            'div',
            { className: 'fam-search', style: { flex: '1 1 auto' } },
            h(IconSearch, { size: 14 }),
            h('input', {
              className: 'fam-search-input',
              placeholder: '按名称、版本或发布者筛选',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== '' ? h(IconButton, { title: '清空', onClick: () => setQuery('') }, h(IconClose, { size: 13 })) : null,
          ),
          h(
            'select',
            { className: 'fam-select', value: scope, onChange: (event) => setScope(event.target.value) },
            h('option', { value: 'all' }, '全部范围'),
            h('option', { value: 'machine' }, '系统级'),
            h('option', { value: 'user' }, '当前用户'),
          ),
          h(
            'select',
            { className: 'fam-select', value: sort, onChange: (event) => setSort(event.target.value) },
            h('option', { value: 'name' }, '按名称'),
            h('option', { value: 'size' }, '按大小'),
            h('option', { value: 'publisher' }, '按发布者'),
            h('option', { value: 'installed' }, '按安装日期'),
          ),
          h(IconButton, { title: '重新扫描注册表', onClick: () => load(true), disabled: loading }, h(IconRefresh, null)),
        ),
        h(
          'div',
          { className: 'fam-app-head' },
          h('div', { className: 'fam-app-name' }, '应用'),
          h('div', { className: 'fam-app-ver' }, '版本'),
          h('div', { className: 'fam-app-pub' }, '发布者'),
          h('div', { className: 'fam-app-actions' }, '操作'),
        ),
        h(
          'div',
          { className: 'fam-app-list' },
          loading && apps.length === 0
            ? h('div', { className: 'fam-state' }, '正在读取注册表…')
            : error !== null
              ? h('div', { className: 'fam-state', 'data-tone': 'error' }, error)
              : filtered.length === 0
                ? h('div', { className: 'fam-state' }, '没有匹配的应用')
                : filtered.map((app) =>
                    h(
                      'div',
                      { key: app.id, className: 'fam-app-row', 'data-busy': busyId === app.id ? '' : undefined },
                      h('div', { className: 'fam-app-name' }, h('span', { className: 'fam-app-glyph' }, h(IconGrid, { size: 15 })), h('span', { className: 'fam-app-title', title: app.name }, app.name), app.sizeKb > 0 ? h('span', { className: 'fam-app-size' }, fmtSize(app.sizeKb * 1024)) : null),
                      h('div', { className: 'fam-app-ver' }, app.version || '—'),
                      h(
                        'div',
                        { className: 'fam-app-pub' },
                        h('span', { className: 'fam-app-publisher', title: app.publisher }, app.publisher || '—'),
                        h('span', { className: 'fam-tag' }, scopeLabel(app)),
                      ),
                      h(
                        'div',
                        { className: 'fam-app-actions' },
                        h(
                          'button',
                          { type: 'button', className: 'fam-btn fam-btn-sm', onClick: () => launch(app), disabled: busyId !== null },
                          h(IconPlay, { size: 13 }),
                          '启动',
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'fam-btn fam-btn-sm', onClick: () => locate(app), disabled: busyId !== null },
                          h(IconLocate, { size: 13 }),
                          '位置',
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'fam-btn fam-btn-sm', 'data-variant': 'danger', onClick: () => setDialog({ app }), disabled: busyId !== null },
                          '卸载',
                        ),
                      ),
                    ),
                  ),
        ),
        h(
          'div',
          { className: 'fam-status' },
          h('span', null, `${filtered.length} 个应用${data ? ` / 共 ${data.total}` : ''}`),
          data ? h('span', null, `用户级 ${data.userCount}`) : null,
          h('span', { className: 'fam-muted' }, '来源：注册表 Uninstall 键'),
        ),
        dialog !== null
          ? h(ConfirmDialog, {
              title: '卸载应用',
              message: `确定要卸载「${dialog.app.name}」吗？`,
              detail: dialog.app.uninstall
                ? `将执行：${dialog.app.uninstall}${dialog.app.quiet ? '\n（若可用会使用静默参数）' : ''}`
                : '这个应用没有登记卸载命令，可能需要在系统设置里卸载。',
              danger: true,
              confirmText: '开始卸载',
              onConfirm: () => {
                const app = dialog.app
                setDialog(null)
                act(app.id, () => api('appUninstall', { id: app.id, quiet: Boolean(app.quiet) }), `已启动卸载程序：${app.name}`)
              },
              onClose: () => setDialog(null),
            })
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // 面板根
    // -----------------------------------------------------------------------

    function PanelPage() {
      const [tab, setTab] = useState('files')
      const [toastState, setToastState] = useState(null)

      const toast = useCallback((text, kind = 'info') => {
        setToastState({ text: String(text), kind, id: Math.random() })
      }, [])

      useEffect(() => {
        if (toastState === null) return undefined
        const timer = setTimeout(() => setToastState(null), 3600)
        return () => clearTimeout(timer)
      }, [toastState])

      const tabButton = (id, label) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'fam-tab',
            'data-active': tab === id ? '' : undefined,
            onClick: () => setTab(id),
          },
          label,
        )

      return h(
        'div',
        { className: 'fam-root', 'data-dsh-plugin': 'file-app-manager' },
        h(
          'header',
          { className: 'fam-head' },
          h('div', { className: 'fam-brand' }, h(PanelIcon, { size: 18, active: true }), h('span', null, '文件与应用')),
          h('div', { className: 'fam-tabs' }, tabButton('files', '文件'), tabButton('apps', '应用')),
          h('div', { className: 'fam-head-spacer' }),
          h('div', { className: 'fam-head-hint' }, '本机操作 · 删除进回收站'),
        ),
        h('div', { className: 'fam-body' }, tab === 'files' ? h(FilesTab, { toast }) : h(AppsTab, { toast })),
        toastState !== null
          ? h('div', { className: 'fam-toast', 'data-tone': toastState.kind }, toastState.text)
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // 样式
    // -----------------------------------------------------------------------

    const CSS = `
.fam-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.fam-head{display:flex;align-items:center;gap:14px;height:52px;padding:0 16px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fam-brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;letter-spacing:.2px}
.fam-tabs{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.fam-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:5px 14px;border-radius:7px;cursor:pointer;transition:background .12s,color .12s}
.fam-tab:hover{color:var(--dsw-alias-label-primary)}
.fam-tab[data-active]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.fam-head-spacer{flex:1 1 auto}
.fam-head-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.fam-body{flex:1 1 auto;min-height:0;display:flex}
.fam-split{display:flex;flex:1 1 auto;min-height:0;width:100%}

.fam-side{width:206px;flex:none;display:flex;flex-direction:column;gap:2px;padding:10px 8px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.fam-side-label{padding:6px 8px 4px;font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.fam-side-item,.fam-side-drive{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;padding:6px 8px;border-radius:7px;cursor:pointer}
.fam-side-item:hover,.fam-side-drive:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fam-side-item[data-active],.fam-side-drive[data-active]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}
.fam-side-glyph{display:inline-flex;color:var(--dsw-alias-brand-primary);opacity:.85;flex:none}
.fam-side-name{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fam-side-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}
.fam-bar{display:block;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.fam-bar-fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);opacity:.7}

.fam-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.fam-toolbar{display:flex;align-items:center;gap:6px;height:44px;padding:0 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fam-toolbar-sep{width:1px;height:18px;margin:0 4px;background:var(--dsw-alias-border-l1)}
.fam-iconbtn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;min-width:28px;padding:0 6px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.fam-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fam-iconbtn:disabled{opacity:.35;cursor:default}
.fam-iconbtn-label{font-size:12px}
.fam-search{display:flex;align-items:center;gap:6px;height:28px;margin-left:auto;padding:0 6px 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);min-width:220px}
.fam-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.fam-search-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;height:100%}
.fam-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.fam-select{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}

.fam-crumbs{display:flex;align-items:center;gap:2px;height:34px;padding:0 12px;flex:none;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;scrollbar-width:none}
.fam-crumbs::-webkit-scrollbar{display:none}
.fam-crumb-wrap{display:inline-flex;align-items:center;gap:2px}
.fam-crumb{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:3px 6px;border-radius:6px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.fam-crumb:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fam-crumb-sep{color:var(--dsw-alias-label-tertiary);font-size:12px}
.fam-crumb-tag{margin-left:8px;padding:2px 8px;border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px}

.fam-thead,.fam-row{display:grid;grid-template-columns:minmax(0,1fr) 148px 118px 92px;align-items:center;gap:10px;padding:0 14px 0 12px}
.fam-thead{height:30px;flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.fam-list{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0}
.fam-row{height:32px;border-radius:7px;margin:1px 6px;cursor:default;color:var(--dsw-alias-label-primary)}
.fam-row:hover{background:var(--dsw-alias-bg-layer-2)}
.fam-row[data-selected]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.fam-row[data-dim] .fam-row-name{color:var(--dsw-alias-label-tertiary)}
.fam-col-name{display:flex;align-items:center;gap:9px;min-width:0}
.fam-row-glyph{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;color:var(--dsw-alias-brand-primary)}
.fam-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fam-col-time,.fam-col-type,.fam-col-size{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fam-col-size{text-align:right}
.fam-muted{color:var(--dsw-alias-label-tertiary)}
.fam-tile{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 3px;border-radius:4px;font-size:8.5px;font-weight:700;letter-spacing:.2px;color:#fff;background:#8a8f98}
.fam-tile[data-kind="doc"]{background:#3b82f6}
.fam-tile[data-kind="sheet"]{background:#16a34a}
.fam-tile[data-kind="slide"]{background:#ea580c}
.fam-tile[data-kind="image"]{background:#a855f7}
.fam-tile[data-kind="video"]{background:#ec4899}
.fam-tile[data-kind="audio"]{background:#f59e0b}
.fam-tile[data-kind="archive"]{background:#b45309}
.fam-tile[data-kind="exe"]{background:#dc2626}
.fam-tile[data-kind="code"]{background:#0d9488}
.fam-tile[data-kind="font"]{background:#6366f1}
.fam-state{padding:36px 20px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.fam-state[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.fam-note{padding:8px 16px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.fam-status{display:flex;align-items:center;gap:16px;height:28px;padding:0 14px;flex:none;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11.5px}

.fam-apps{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%}
.fam-app-head,.fam-app-row{display:grid;grid-template-columns:minmax(0,1fr) 96px minmax(160px,240px) 216px;align-items:center;gap:12px;padding:0 16px}
.fam-app-head{height:32px;flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.fam-app-list{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0}
.fam-app-row{min-height:46px;padding:6px 16px;border-radius:8px;margin:1px 8px}
.fam-app-row:hover{background:var(--dsw-alias-bg-layer-2)}
.fam-app-row[data-busy]{opacity:.55}
.fam-app-name{display:flex;align-items:center;gap:9px;min-width:0}
.fam-app-glyph{display:inline-flex;color:var(--dsw-alias-brand-primary);flex:none}
.fam-app-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fam-app-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:1px 6px;border-radius:20px;background:var(--dsw-alias-bg-layer-2)}
.fam-app-ver{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis}
.fam-app-pub{display:flex;align-items:center;gap:8px;min-width:0}
.fam-app-publisher{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fam-tag{flex:none;font-size:10.5px;padding:1px 7px;border-radius:20px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.fam-app-actions{display:flex;align-items:center;gap:6px;justify-content:flex-end}

.fam-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.fam-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.fam-btn:disabled{opacity:.45;cursor:default}
.fam-btn-sm{height:26px;padding:0 9px;font-size:12px}
.fam-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.fam-btn[data-variant="danger"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
.fam-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}

.fam-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
.fam-dialog{width:min(420px,calc(100vw - 48px));border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden}
.fam-dialog-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fam-dialog-body{padding:14px;display:flex;flex-direction:column;gap:8px}
.fam-dialog-text{font-size:13px}
.fam-dialog-detail{white-space:pre-wrap;word-break:break-all;font-size:11.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:8px}
.fam-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.fam-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.fam-input{height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:0}
.fam-input:focus{border-color:var(--dsw-alias-brand-primary)}

.fam-menu{position:fixed;z-index:70;min-width:190px;padding:5px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 14px 34px rgba(0,0,0,.28)}
.fam-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;padding:6px 9px;border-radius:6px;cursor:pointer}
.fam-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.fam-menu-item:disabled{opacity:.4;cursor:default}
.fam-menu-item[data-danger]{color:var(--dsw-alias-state-error-primary)}
.fam-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.fam-menu-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}

.fam-toast{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);max-width:min(560px,calc(100% - 40px));padding:8px 14px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 26px rgba(0,0,0,.24);font-size:12.5px;z-index:50}
.fam-toast[data-tone="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary)}
`

    // -----------------------------------------------------------------------
    // cordis 客户端插件
    // -----------------------------------------------------------------------

    const inject = ['slots', 'layout']

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-file-app-manager', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'file-app-manager: styles')

      ctx.effect(() => {
        const slots = ctx.slots
        const disposers = []
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 25,
                label: () => '文件与应用',
              },
              PanelIcon,
            ),
          ),
        )
        disposers.push(
          slots.inject('main', () =>
            slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({}),
              },
              PanelPage,
            ),
          ),
        )
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      }, 'file-app-manager: ui')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
