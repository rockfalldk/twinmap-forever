// Reads one row of pixels off a window, as it is on screen, with X11. This is how the app reads the
// strip the addon draws on Linux, where the game runs under Wine as an X11 window (XWayland on a
// Wayland session). It only reads the screen: nothing is sent to the window. The library loads on
// the first call, so that this file can sit bundled on Windows too, where capture.ts never calls
// it; with no X display (DISPLAY unset, no XWayland) every function here gives null.
import koffi from 'koffi'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { winePathToUnix } from './client-files'

/** A window, as X11 names it: an XID. */
export type WindowHandle = bigint

const ZPIXMAP = 2
const ALL_PLANES = -1n // every plane
const IS_VIEWABLE = 2 // XWindowAttributes.map_state

koffi.struct('XWindowAttributes', {
  x: 'int', y: 'int', width: 'int', height: 'int', border_width: 'int', depth: 'int',
  visual: 'void *', root: 'uint64_t', class: 'int', bit_gravity: 'int', win_gravity: 'int',
  backing_store: 'int', backing_planes: 'uint64_t', backing_pixel: 'uint64_t', save_under: 'int',
  colormap: 'uint64_t', map_installed: 'int', map_state: 'int', all_event_masks: 'int64_t',
  your_event_mask: 'int64_t', do_not_propagate_mask: 'int64_t', override_redirect: 'int', screen: 'void *',
})
const XImageT = koffi.struct('XImage', {
  width: 'int', height: 'int', xoffset: 'int', data: 'void *', format: 'int', bitmap: 'void *',
  byte_order: 'int', bitmap_unit: 'int', bitmap_bit_order: 'int', bitmap_pad: 'int', depth: 'int',
  bytes_per_line: 'int', bits_per_pixel: 'int', red_mask: 'uint64_t', green_mask: 'uint64_t', blue_mask: 'uint64_t',
  obdata: 'void *',
  f: koffi.struct('XImageFuncs', { create_image: 'void *', destroy_image: 'void *', get_pixel: 'void *', put_pixel: 'void *', sub_image: 'void *', add_pixel: 'void *' }),
})

/** The last anomaly while reading a window, for the record (empty when all reads went well). */
let lastRead = ''
export function readNote(): string {
  return lastRead
}
koffi.struct('XClassHint', { res_name: 'char *', res_class: 'char *' })
// A prototype cannot be a parameter type in koffi, so the error handler goes in as a void *:
// a pointer made by koffi.register below.
const XErrorHandler = koffi.proto('int __cdecl XErrorHandler(void *display, void *event)')

let api: ReturnType<typeof load> | null = null
let failed = false
let whyNoDisplay = ''
function x11(): ReturnType<typeof load> | null {
  if (api) return api
  if (failed) return null
  try {
    return (api = load())
  } catch (e) {
    failed = true // no X display, or no libX11: nothing here can be read
    whyNoDisplay = e instanceof Error ? e.message : String(e)
    return null
  }
}

/** The X displays to try: DISPLAY, the usual numbers, and every socket in /tmp/.X11-unix. */
function displayNames(): (string | null)[] {
  const out: (string | null)[] = [null, ':0', ':1', ':2']
  try {
    for (const s of readdirSync('/tmp/.X11-unix')) {
      const m = /^X(\d+)$/.exec(s)
      if (m) out.push(`:${m[1]}`)
    }
  } catch {
    // no X sockets at all
  }
  return out
}

/**
 * Every X11 call this file makes, as a koffi signature. capture-x11.test.ts parses them all, so a
 * signature koffi rejects fails the tests instead of the app on a player's screen (a prototype may
 * not be a parameter type: the error handler goes in as a void *).
 */
export const X11_FUNCS = {
  OpenDisplay: 'void * __cdecl XOpenDisplay(const char *name)',
  CloseDisplay: 'int __cdecl XCloseDisplay(void *)',
  DefaultRootWindow: 'uint64_t __cdecl XDefaultRootWindow(void *)',
  QueryTree: 'int __cdecl XQueryTree(void *, uint64_t, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ void **, _Out_ uint32_t *)',
  Free: 'int __cdecl XFree(void *)',
  InternAtom: 'uint64_t __cdecl XInternAtom(void *, const char *, int)',
  GetWindowProperty: 'int __cdecl XGetWindowProperty(void *, uint64_t, uint64_t, long, long, int, uint64_t, _Out_ uint64_t *, _Out_ int *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint8_t **)',
  GetWindowAttributes: 'int __cdecl XGetWindowAttributes(void *, uint64_t, XWindowAttributes *)',
  GetGeometry: 'int __cdecl XGetGeometry(void *, uint64_t, _Out_ uint64_t *, _Out_ int *, _Out_ int *, _Out_ uint32_t *, _Out_ uint32_t *, _Out_ uint32_t *, _Out_ uint32_t *)',
  TranslateCoordinates: 'int __cdecl XTranslateCoordinates(void *, uint64_t, uint64_t, int, int, _Out_ int *, _Out_ int *, _Out_ uint64_t *)',
  GetImage: 'void * __cdecl XGetImage(void *, uint64_t, int, int, uint32_t, uint32_t, uint64_t, int)',
  DestroyImage: 'int __cdecl XDestroyImage(void *)',
  FetchName: 'int __cdecl XFetchName(void *, uint64_t, _Out_ char **)',
  GetClassHint: 'int __cdecl XGetClassHint(void *, uint64_t, XClassHint *)',
  SetErrorHandler: 'void * __cdecl XSetErrorHandler(void *, void *)',
} as const

function load() {
  let lib: ReturnType<typeof koffi.load>
  try {
    lib = koffi.load('libX11.so.6')
  } catch {
    lib = koffi.load('libX11.so')
  }
  const fns = Object.fromEntries(Object.entries(X11_FUNCS).map(([k, s]) => [k, lib.func(s)])) as Record<keyof typeof X11_FUNCS, ReturnType<typeof lib.func>>
  const OpenDisplay = fns.OpenDisplay
  // DISPLAY may be unset on a Wayland session where XWayland still listens: try every socket there too.
  const dpy = displayNames().map((d) => OpenDisplay(d) as unknown).find(Boolean)
  if (!dpy) {
    let sockets = ''
    try {
      sockets = readdirSync('/tmp/.X11-unix').join(',')
    } catch {
      sockets = '(no /tmp/.X11-unix)'
    }
    throw new Error(
      `no X display (session=${process.env.XDG_SESSION_TYPE ?? '?'}, DISPLAY=${process.env.DISPLAY ?? 'unset'}, XAUTHORITY=${process.env.XAUTHORITY ?? 'unset'}, sockets=${sockets}); run the game through X11/XWayland for the screen to be read`,
    )
  }
  const api = { dpy, root: 0n as bigint, ...fns }
  api.root = api.DefaultRootWindow(dpy) as bigint
  // Without this, reading a window that is gone in the meantime would end the process.
  const noError = koffi.register(() => 0, koffi.pointer(XErrorHandler))
  api.SetErrorHandler(dpy, noError)
  return api
}

/** The children of a window, as X11 ids. */
function childrenOf(a: NonNullable<ReturnType<typeof x11>>, w: bigint): WindowHandle[] {
  const root = [0n], parent = [0n], children: [unknown] = [null], n = [0]
  if (!a.QueryTree(a.dpy, w, root, parent, children, n) || !children[0]) return []
  const list = [...(koffi.decode(children[0], koffi.array('uint64_t', n[0]!)) as bigint[])]
  a.Free(children[0])
  return list
}

/**
 * Every window of the screen, as X11 ids. The whole tree, not only the root's children: a
 * reparenting window manager (KWin, Mutter, ...) puts each program's window inside a frame of its
 * own, and the game's window is then not a top-level one.
 */
function allWindows(a: NonNullable<ReturnType<typeof x11>>): WindowHandle[] {
  const out: WindowHandle[] = []
  const walk = (w: bigint, depth: number): void => {
    if (depth > 8) return
    for (const c of childrenOf(a, w)) {
      out.push(c)
      walk(c, depth + 1)
    }
  }
  walk(a.root, 0)
  return out
}

/** The process that owns a window, from its _NET_WM_PID, or null. */
function pidOf(a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle): number | null {
  const atom = a.InternAtom(a.dpy, '_NET_WM_PID', 0) as bigint
  const type = [0n], format = [0], n = [0n], after = [0n], prop: [unknown] = [null]
  if (a.GetWindowProperty(a.dpy, hwnd, atom, 0, 1, 0, 0, type, format, n, after, prop) !== 0 || !prop[0]) return null
  const pid = Number(koffi.decode(prop[0], 'uint64_t'))
  a.Free(prop[0])
  return pid
}

/** The argument of a command line that is a program: Wine runs the game with its Windows path in it. */
export function exeTokenOf(cmdline: string): string | null {
  const args = cmdline.split('\0').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return args.find((a) => /\.exe$/i.test(a)) ?? null
}

/** The class of a window, as the program sets it (Wine sets the .exe's name), or null. A char * field decodes as a string already. */
function classOf(a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle): string | null {
  const hint = koffi.alloc('XClassHint', 1)
  if (!a.GetClassHint(a.dpy, hwnd, hint)) return null
  const h = koffi.decode(hint, 'XClassHint') as { res_name: string | null; res_class: string | null }
  return h.res_class || h.res_name || null
}

/** The full path of the program that owns a window, as a path on this computer, or null. */
export function programOf(hwnd: WindowHandle): string | null {
  const a = x11()
  if (!a) return null
  const pid = pidOf(a, hwnd)
  if (pid === null) return classOf(a, hwnd) // no _NET_WM_PID: the class is what the program says
  let cmd = ''
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return null
  }
  const token = exeTokenOf(cmd)
  if (token) {
    const unix = token.startsWith('/') ? token : winePathToUnix(token)
    if (unix && existsSync(unix)) return unix
    return token // a bare "Wow.exe" still names the program
  }
  // Without an .exe to map: the working directory stands for the program.
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/** The first top-level window with exactly this title, or null. */
export function findWindow(title: string): WindowHandle | null {
  const a = x11()
  if (!a) return null
  for (const w of allWindows(a)) {
    const name: [unknown] = [null]
    if (!a.FetchName(a.dpy, w, name) || !name[0]) continue
    const text = koffi.decode(name[0], 'str') as string
    a.Free(name[0])
    if (text === title) return w
  }
  return null
}

/**
 * Every visible window, as "class<program>", for the record when the game is not found: what the
 * screen holds, so a miss says why.
 */
export function describeScreen(): string[] {
  const a = x11()
  if (!a) return [`no X display: ${whyNoDisplay}`]
  const out: string[] = []
  for (const w of allWindows(a)) {
    if (mapStateOf(a, w) !== IS_VIEWABLE) continue
    try {
      out.push(`${classOf(a, w) ?? '?'} <${programOf(w) ?? '?'}>`)
    } catch {
      out.push('?')
    }
    if (out.length >= 30) break
  }
  return out.length ? out : ['no visible windows']
}

/** The first visible window of a program whose full path matches, or null. */
export function findWindowOf(program: RegExp): WindowHandle | null {
  const a = x11()
  if (!a) return null
  for (const w of allWindows(a)) {
    if (mapStateOf(a, w) !== IS_VIEWABLE) continue
    if (program.test(programOf(w) ?? '')) return w
  }
  return null
}

const mapStateOf = (a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle): number => {
  const attrs = koffi.alloc('XWindowAttributes', 1)
  if (!a.GetWindowAttributes(a.dpy, hwnd, attrs)) return -1
  return koffi.decode(attrs, 'XWindowAttributes').map_state as number
}

/** Whether a window is still there, and whether there is anything of it on screen. */
export function windowState(hwnd: WindowHandle): 'gone' | 'minimized' | 'open' {
  const a = x11()
  if (!a) return 'gone'
  const state = mapStateOf(a, hwnd)
  if (state < 0) return 'gone'
  return state === IS_VIEWABLE ? 'open' : 'minimized'
}

/** The size of a window's drawing area, or null when there is none. On X11 the window is its own client area. */
function sizeOf(a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle): { width: number; height: number } | null {
  const root = [0n], x = [0], y = [0], w = [0], h = [0], border = [0], depth = [0]
  if (!a.GetGeometry(a.dpy, hwnd, root, x, y, w, h, border, depth)) return null
  return { width: w[0]!, height: h[0]! }
}

/** Where a point of a window lies on the root window. */
function toRoot(a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle, x: number, y: number): { x: number; y: number } {
  const dx = [0], dy = [0], child = [0n]
  a.TranslateCoordinates(a.dpy, hwnd, a.root, x, y, dx, dy, child)
  return { x: dx[0]!, y: dy[0]! }
}

const shiftOf = (mask: number): number => {
  let s = 0
  while (mask > 0 && (mask & 1) === 0) {
    mask >>>= 1
    s++
  }
  return s
}

/**
 * The pixels of an X11 image buffer, three bytes a pixel red first (order "rgb") or four a pixel in
 * the order blue, green, red, unused (order "bgra", as readRow gives on Windows). The masks say
 * where each colour sits in a pixel, as the screen puts it.
 */
export function pixelsFrom(data: Buffer, width: number, height: number, bytesPerLine: number, bitsPerPixel: number, littleEndian: boolean, redMask: number, greenMask: number, blueMask: number, order: 'rgb' | 'bgra'): Uint8Array {
  const bypp = Math.max(1, bitsPerPixel >> 3)
  const rs = shiftOf(redMask), gs = shiftOf(greenMask), bs = shiftOf(blueMask)
  const rm = redMask >>> rs, gm = greenMask >>> gs, bm = blueMask >>> bs
  const out: Uint8Array = order === 'rgb' ? new Uint8Array(width * height * 3) : Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * bytesPerLine + x * bypp
      const px = bitsPerPixel === 32 ? (littleEndian ? data.readUInt32LE(at) : data.readUInt32BE(at)) : bitsPerPixel === 24 ? (littleEndian ? data.readUIntLE(at, 3) : data.readUIntBE(at, 3)) : 0
      const r = rm ? Math.round((((px & redMask) >>> rs) * 255) / rm) : 0
      const g = gm ? Math.round((((px & greenMask) >>> gs) * 255) / gm) : 0
      const b = bm ? Math.round((((px & blueMask) >>> bs) * 255) / bm) : 0
      const i = (y * width + x) * (order === 'rgb' ? 3 : 4)
      if (order === 'rgb') {
        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
      } else {
        out[i] = b
        out[i + 1] = g
        out[i + 2] = r
        out[i + 3] = 0
      }
    }
  }
  return out
}

/** A rectangle of the window, as shown on screen, read with XGetImage. Null when there is nothing to read, or the rectangle reaches past the window. */
function imageOf(a: NonNullable<ReturnType<typeof x11>>, hwnd: WindowHandle, x: number, y: number, width: number, height: number, order: 'rgb' | 'bgra'): Uint8Array | null {
  let img: unknown
  try {
    img = a.GetImage(a.dpy, hwnd, x, y, width, height, ALL_PLANES, ZPIXMAP)
  } catch (e) {
    lastRead = `GetImage failed: ${e instanceof Error ? e.message : e}`
    return null
  }
  if (!img) return null
  try {
    const im = koffi.decode(img, XImageT) as { width: number; height: number; bytes_per_line: number; bits_per_pixel: number; format: number; byte_order: number; red_mask: bigint; green_mask: bigint; blue_mask: bigint; data: unknown }
    const len = (im.bytes_per_line | 0) * (im.height | 0)
    if (!im.data || !(len > 0)) {
      const raw = koffi.decode(img, koffi.array('uint8_t', 96, 'Buffer')) as Buffer
      lastRead = `empty image req=${width}x${height}: w=${im.width} h=${im.height} bpl=${im.bytes_per_line} bpp=${im.bits_per_pixel} fmt=${im.format} img=${typeof img} raw=${raw.toString('hex')}`
      return null
    }
    const data = koffi.decode(im.data, koffi.array('uint8_t', len, 'Buffer')) as Buffer
    lastRead = ''
    return pixelsFrom(data, width, height, im.bytes_per_line, im.bits_per_pixel, im.byte_order === 0, Number(im.red_mask), Number(im.green_mask), Number(im.blue_mask), order)
  } catch (e) {
    lastRead = `image read failed: ${e instanceof Error ? e.message : e}`
    return null
  } finally {
    try {
      a.DestroyImage(img)
    } catch {
      // the window is already gone
    }
  }
}

/**
 * A rectangle of the window, as shown on screen: three bytes a pixel (red, green, blue), rows from
 * the top. x, y: its top left corner, in pixels of the window. own is not looked at on X11: there is
 * no cheap way to tell what lies over a window, and the readers of the strip tolerate a covered edge.
 * at: where its top left corner is on the screen.
 */
export function readRect(hwnd: WindowHandle, x: number, y: number, width: number, height: number, own = false): { width: number; height: number; rgb: Uint8Array; at: { x: number; y: number } } | null {
  const a = x11()
  if (!a || width <= 0 || height <= 0) return null
  const size = sizeOf(a, hwnd)
  if (!size || x < 0 || y < 0 || x + width > size.width || y + height > size.height) return null
  const rgb = imageOf(a, hwnd, x, y, width, height, 'rgb')
  if (!rgb) return null
  return { width, height, rgb, at: toRoot(a, hwnd, x, y) }
}

/** A square of the window, read the same way. */
export function readBox(hwnd: WindowHandle, x: number, y: number, size: number): { size: number; rgb: Uint8Array } | null {
  const read = readRect(hwnd, x, y, size, size)
  return read && { size, rgb: read.rgb }
}

/**
 * Whether a square of the window shows the window and nothing of another program: asked before a
 * piece of the screen leaves this computer (samples.ts). On X11 that is not told cheaply, so it is
 * always yes here.
 */
export function showsOnly(hwnd: WindowHandle, x: number, y: number, size: number): boolean {
  const a = x11()
  if (!a) return false
  return sizeOf(a, hwnd) !== null
}

/**
 * The top or bottom row of the window, as shown on screen: 4 bytes per pixel, in the order blue,
 * green, red, unused. Null when there is nothing to read: the window is gone, not on screen or
 * empty. A window covered by another one gives the pixels of what covers it.
 */
export function readRow(hwnd: WindowHandle, edge: 'top' | 'bottom' = 'top'): Buffer | null {
  const a = x11()
  if (!a) return null
  const size = sizeOf(a, hwnd)
  if (!size || size.width <= 0 || size.height <= 0) return null
  const row = imageOf(a, hwnd, 0, edge === 'top' ? 0 : size.height - 1, size.width, 1, 'bgra')
  return row ? (Buffer.from(row.buffer, row.byteOffset, row.byteLength) as Buffer) : null
}
