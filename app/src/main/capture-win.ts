// Reads one row of pixels off a window, as it is on screen, with the Windows graphics calls (GDI).
// This is how the app reads the strip the addon draws. It only reads the screen: nothing is sent
// to the window. Windows only: the libraries load on the first call, so that this file can sit
// bundled on Linux too, where capture.ts never calls it.
import koffi from 'koffi'

koffi.struct('POINT', { x: 'long', y: 'long' })
koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })

/** A window, as Windows names it. */
export type WindowHandle = bigint

let api: ReturnType<typeof load> | null = null
const win = (): ReturnType<typeof load> => (api ??= load())

function load() {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const api = {
    SetProcessDPIAware: user32.func('int __stdcall SetProcessDPIAware()'),
    FindWindowW: user32.func('void * __stdcall FindWindowW(str16 cls, str16 title)'),
    FindWindowExW: user32.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
    IsWindow: user32.func('int __stdcall IsWindow(void *hwnd)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hwnd)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: kernel32.func(
      'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)',
    ),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *handle)'),
    IsIconic: user32.func('int __stdcall IsIconic(void *hwnd)'),
    GetClientRect: user32.func('int __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)'),
    ClientToScreen: user32.func('int __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *point)'),
    WindowFromPoint: user32.func('void * __stdcall WindowFromPoint(POINT point)'),
    GetDC: user32.func('void * __stdcall GetDC(void *hwnd)'),
    CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *dc)'),
    CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *dc, int width, int height)'),
    SelectObject: gdi32.func('void * __stdcall SelectObject(void *dc, void *object)'),
    DeleteObject: gdi32.func('int __stdcall DeleteObject(void *object)'),
    BitBlt: gdi32.func(
      'int __stdcall BitBlt(void *dst, int x, int y, int width, int height, void *src, int srcX, int srcY, uint32_t rop)',
    ),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(void *dc, void *bitmap, uint32_t start, uint32_t lines, void *bits, void *info, uint32_t usage)',
    ),
    SRCCOPY: 0x00cc0020,
  }
  // Physical pixels, whatever the display scaling. Does nothing where the process already is, as in Electron.
  api.SetProcessDPIAware()
  return api
}

/** The first top-level window with exactly this title, or null. */
export function findWindow(title: string): WindowHandle | null {
  return (win().FindWindowW(null, title) as WindowHandle | null) || null
}

/** The full path of the program that owns a window, or null when Windows will not say. */
export function programOf(hwnd: WindowHandle): string | null {
  const pid = [0]
  win().GetWindowThreadProcessId(hwnd, pid)
  const process = win().OpenProcess(0x1000, 0, pid[0]!) as bigint | null // PROCESS_QUERY_LIMITED_INFORMATION
  if (!process) return null
  const name = Buffer.alloc(2 * 1024), size = [1024]
  const ok = win().QueryFullProcessImageNameW(process, 0, name, size)
  win().CloseHandle(process)
  return ok ? name.toString('utf16le', 0, size[0]! * 2) : null
}

/** The first visible top-level window of a program whose full path matches, or null. */
export function findWindowOf(program: RegExp): WindowHandle | null {
  let hwnd: WindowHandle | null = null
  while ((hwnd = (win().FindWindowExW(null, hwnd, null, null) as WindowHandle | null) || null)) {
    if (win().IsWindowVisible(hwnd) && program.test(programOf(hwnd) ?? '')) return hwnd
  }
  return null
}

/** Whether a window is still there, and whether there is anything of it on screen. */
export function windowState(hwnd: WindowHandle): 'gone' | 'minimized' | 'open' {
  if (!win().IsWindow(hwnd)) return 'gone'
  return win().IsIconic(hwnd) ? 'minimized' : 'open'
}

// Kept between calls: the row is read many times a second.
let screenDC: bigint | undefined, memoryDC: bigint, bitmap: bigint | undefined, bitmapWidth = 0
const info = Buffer.alloc(40) // BITMAPINFOHEADER: 32 bits per pixel, uncompressed
info.writeInt32LE(40, 0)
info.writeInt32LE(1, 8) // height
info.writeUInt16LE(1, 12) // planes
info.writeUInt16LE(32, 14) // bits per pixel

const processOf = (hwnd: WindowHandle | null): number => {
  const pid = [0]
  if (hwnd) win().GetWindowThreadProcessId(hwnd, pid)
  return pid[0]!
}

/**
 * A rectangle of the window's client area, as shown on screen: three bytes a pixel (red, green,
 * blue), rows from the top. x, y: its top left corner, in pixels of the window. Null when there is
 * nothing to read, or the rectangle reaches past the window. own: null too when anything of another
 * program lies over its corners or its middle, so that what is read is the window's and nothing else's.
 * at: where its top left corner is on the desktop.
 */
export function readRect(hwnd: WindowHandle, x: number, y: number, width: number, height: number, own = false): { width: number; height: number; rgb: Uint8Array; at: { x: number; y: number } } | null {
  if (win().IsIconic(hwnd) || width <= 0 || height <= 0) return null
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!win().GetClientRect(hwnd, rect) || x < 0 || y < 0 || x + width > rect.right || y + height > rect.bottom) return null
  const origin = { x, y }
  if (!win().ClientToScreen(hwnd, origin)) return null
  if (own) {
    const program = processOf(hwnd)
    for (const [dx, dy] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [width >> 1, height >> 1]]) {
      if (processOf(win().WindowFromPoint({ x: origin.x + dx!, y: origin.y + dy! }) as WindowHandle | null) !== program) return null
    }
  }
  if (screenDC === undefined) {
    screenDC = win().GetDC(null) as bigint
    memoryDC = win().CreateCompatibleDC(screenDC) as bigint
  }
  // Made and let go each time: it is asked for twice a second at most.
  const box = win().CreateCompatibleBitmap(screenDC, width, height) as bigint
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(width, 4)
  head.writeInt32LE(-height, 8) // top row first
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  const previous = win().SelectObject(memoryDC, box)
  const copied = win().BitBlt(memoryDC, 0, 0, width, height, screenDC, origin.x, origin.y, win().SRCCOPY)
  win().SelectObject(memoryDC, previous)
  const pixels = Buffer.alloc(width * height * 4)
  const read = copied && win().GetDIBits(screenDC, box, 0, height, pixels, head, 0) === height
  win().DeleteObject(box)
  if (!read) return null
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = pixels[i * 4 + 2]!
    rgb[i * 3 + 1] = pixels[i * 4 + 1]!
    rgb[i * 3 + 2] = pixels[i * 4]!
  }
  return { width, height, rgb, at: origin }
}

/** A square of the window's client area, read the same way. */
export function readBox(hwnd: WindowHandle, x: number, y: number, size: number): { size: number; rgb: Uint8Array } | null {
  const read = readRect(hwnd, x, y, size, size)
  return read && { size, rgb: read.rgb }
}

/**
 * Whether a square of the window's client area shows the window and nothing of another program:
 * asked before a piece of the screen leaves this computer (samples.ts). A point every few pixels.
 */
export function showsOnly(hwnd: WindowHandle, x: number, y: number, size: number): boolean {
  const origin = { x, y }
  if (win().IsIconic(hwnd) || !win().ClientToScreen(hwnd, origin)) return false
  const program = processOf(hwnd), step = Math.max(1, Math.floor(size / 16))
  for (let dy = 0; dy < size; dy += step) for (let dx = 0; dx < size; dx += step) if (processOf(win().WindowFromPoint({ x: origin.x + dx, y: origin.y + dy }) as WindowHandle | null) !== program) return false
  return true
}

/**
 * The top or bottom row of the window's client area, as shown on screen: 4 bytes per pixel, in the
 * order blue, green, red, unused. Null when there is nothing to read: the window is gone, minimized
 * or empty. A window covered by another one gives the pixels of what covers it.
 */
export function readRow(hwnd: WindowHandle, edge: 'top' | 'bottom' = 'top'): Buffer | null {
  if (win().IsIconic(hwnd)) return null
  const rect = { left: 0, top: 0, right: 0, bottom: 0 }
  if (!win().GetClientRect(hwnd, rect) || rect.right <= 0 || rect.bottom <= 0) return null
  const origin = { x: 0, y: edge === 'top' ? 0 : rect.bottom - 1 }
  if (!win().ClientToScreen(hwnd, origin)) return null
  const width = rect.right

  if (screenDC === undefined) {
    screenDC = win().GetDC(null) as bigint
    memoryDC = win().CreateCompatibleDC(screenDC) as bigint
  }
  if (width !== bitmapWidth) {
    if (bitmap !== undefined) win().DeleteObject(bitmap)
    bitmap = win().CreateCompatibleBitmap(screenDC, width, 1) as bigint
    bitmapWidth = width
    info.writeInt32LE(width, 4)
  }

  // GetDIBits wants the bitmap out of the device context again.
  const previous = win().SelectObject(memoryDC, bitmap)
  const copied = win().BitBlt(memoryDC, 0, 0, width, 1, screenDC, origin.x, origin.y, win().SRCCOPY)
  win().SelectObject(memoryDC, previous)
  const pixels = Buffer.alloc(width * 4)
  if (!copied || win().GetDIBits(screenDC, bitmap, 0, 1, pixels, info, 0) !== 1) return null
  return pixels
}
