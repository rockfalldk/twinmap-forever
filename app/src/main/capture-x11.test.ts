import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { exeTokenOf, pixelsFrom } from './capture-x11'
import { winePathToUnix, winePrefixes } from './client-files'

test('the pixels of an X11 image come out red first, or in the order blue, green, red, unused of a row', () => {
  // 2x2 pixels of 32 bits, little endian, the masks of a usual screen: red 0xff0000, green 0xff00, blue 0xff.
  const px = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b
  const data = Buffer.alloc(2 * 8) // two rows of two pixels, 8 bytes a row
  data.writeUInt32LE(px(255, 0, 0), 0)
  data.writeUInt32LE(px(0, 255, 0), 4)
  data.writeUInt32LE(px(0, 0, 255), 8)
  data.writeUInt32LE(px(255, 255, 255), 12)
  expect([...pixelsFrom(data, 2, 2, 8, 32, true, 0xff0000, 0xff00, 0xff, 'rgb')]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
  expect([...pixelsFrom(data, 2, 2, 8, 32, true, 0xff0000, 0xff00, 0xff, 'bgra')]).toEqual([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  // Big endian, and the colours the other way round in a pixel as some screens put them: red low, blue high.
  const be = Buffer.alloc(2 * 8)
  const qx = (r: number, g: number, b: number): number => (b << 16) | (g << 8) | r
  be.writeUInt32BE(qx(255, 0, 0), 0)
  be.writeUInt32BE(qx(0, 255, 0), 4)
  be.writeUInt32BE(qx(0, 0, 255), 8)
  be.writeUInt32BE(qx(255, 255, 255), 12)
  expect([...pixelsFrom(be, 2, 2, 8, 32, false, 0xff, 0xff00, 0xff0000, 'rgb')]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
})

test('the program of a Wine process is the .exe in its command line', () => {
  expect(exeTokenOf('wine64\0C:\\Games\\World of Warcraft\\_forever_\\Wow.exe\0')).toBe('C:\\Games\\World of Warcraft\\_forever_\\Wow.exe')
  expect(exeTokenOf('/usr/bin/wine64\0/home/me/games/wow/_forever_/Wow.exe\0')).toBe('/home/me/games/wow/_forever_/Wow.exe')
  expect(exeTokenOf('some daemon\0--flag\0')).toBeNull()
})

// Wine prefixes are a Linux thing: on Windows this test has nothing to map through.
test.skipIf(process.platform === 'win32')('a Windows path under Wine maps through the prefixes, and another drive to /', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'twinmap-wine-'))
  mkdirSync(join(prefix, 'drive_c', 'Games', 'World of Warcraft', '_forever_'), { recursive: true })
  process.env.WINEPREFIX = prefix
  try {
    expect(winePrefixes()[0]).toBe(prefix)
    expect(winePathToUnix('C:\\Games\\World of Warcraft\\_forever_\\Wow.exe')).toBe(join(prefix, 'drive_c', 'Games', 'World of Warcraft', '_forever_', 'Wow.exe'))
    expect(winePathToUnix('Z:\\home\\me\\wow\\Wow.exe')).toBe(join('/', 'home', 'me', 'wow', 'Wow.exe'))
    expect(winePathToUnix('/already/unix/Wow.exe')).toBe('/already/unix/Wow.exe')
    expect(winePathToUnix('no drive at all')).toBeNull()
  } finally {
    delete process.env.WINEPREFIX
  }
})
