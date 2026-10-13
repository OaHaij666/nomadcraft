import { app, nativeImage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
export function applicationIcon(harmonious: boolean) {
  return join(__dirname, harmonious ? 'icon-harmonious.png' : 'icon-original.png')
}
export function applyApplicationIcon(window: BrowserWindow | null, harmonious: boolean) {
  const image = nativeImage.createFromPath(applicationIcon(harmonious))
  if (image.isEmpty()) return
  if (window && !window.isDestroyed()) window.setIcon(image)
  if (process.platform === 'darwin') app.dock?.setIcon(image)
}
