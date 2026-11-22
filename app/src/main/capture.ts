// Reads pixels off the screen of another program's window, chosen once by platform: the Windows
// graphics calls on Windows (capture-win.ts), X11 on Linux (capture-x11.ts), where the game runs
// under Wine as an X window. This is how the app reads the strip the addon draws at the edge of the
// game window. Both backends are bundled, so neither loads its libraries before it is chosen here.
// Everything the app reads from the screen goes through this file.
import * as win from './capture-win'
import * as x11 from './capture-x11'

const impl = process.platform === 'win32' ? win : x11

/** A window, as the platform names it. */
export type WindowHandle = bigint

/** The first top-level window with exactly this title, or null. */
export const findWindow = (title: string): WindowHandle | null => impl.findWindow(title)

/** The full path of the program that owns a window, or null when the system will not say. */
export const programOf = (hwnd: WindowHandle): string | null => impl.programOf(hwnd)

/** The first visible top-level window of a program whose full path matches, or null. */
export const findWindowOf = (program: RegExp): WindowHandle | null => impl.findWindowOf(program)

/**
 * The window of World of Warcraft: Forever, or null when the game is not open. Found by its program,
 * not its title: the title changes with the client's language (a Chinese player's game was not found
 * by "World of Warcraft"), and other clients of the game share it. Forever runs from _forever_,
 * with either path separator (a Wine path on Linux).
 */
export const findGameWindow = (): WindowHandle | null =>
  impl.findWindowOf(/[\\/]_forever_[\\/]wow\.exe$/i) ??
  // On Linux a window without _NET_WM_PID is known only by its class, which is the bare .exe's name.
  (process.platform === 'win32' ? null : impl.findWindowOf(/wow\.exe$/i))

/** Whether a window is still there, and whether there is anything of it on screen. */
export const windowState = (hwnd: WindowHandle): 'gone' | 'minimized' | 'open' => impl.windowState(hwnd)

/**
 * A rectangle of the window's drawing area, as shown on screen: three bytes a pixel (red, green,
 * blue), rows from the top. x, y: its top left corner, in pixels of the window. Null when there is
 * nothing to read, or the rectangle reaches past the window. own: null too when anything of another
 * program lies over it (Windows only; on X11 it is not told). at: where its top left corner is on the
 * screen.
 */
export const readRect = (hwnd: WindowHandle, x: number, y: number, width: number, height: number, own = false): { width: number; height: number; rgb: Uint8Array; at: { x: number; y: number } } | null => impl.readRect(hwnd, x, y, width, height, own)

/** A square of the window's drawing area, read the same way. */
export const readBox = (hwnd: WindowHandle, x: number, y: number, size: number): { size: number; rgb: Uint8Array } | null => impl.readBox(hwnd, x, y, size)

/**
 * The top or bottom row of the window's drawing area, as shown on screen: 4 bytes per pixel, in the
 * order blue, green, red, unused. Null when there is nothing to read. A window covered by another
 * one gives the pixels of what covers it.
 */
export const readRow = (hwnd: WindowHandle, edge: 'top' | 'bottom' = 'top'): Buffer | null => impl.readRow(hwnd, edge)

/**
 * Whether a square of the window shows the window and nothing of another program: asked before a
 * piece of the screen leaves this computer (samples.ts). Always yes on X11.
 */
export const showsOnly = (hwnd: WindowHandle, x: number, y: number, size: number): boolean => impl.showsOnly(hwnd, x, y, size)

/**
 * Every visible window, as "class<program>", for the record when the game is not found (Linux;
 * empty on Windows). What the screen holds, so a miss says why.
 */
export const describeScreen = (): string[] => (process.platform === 'win32' ? [] : x11.describeScreen())
