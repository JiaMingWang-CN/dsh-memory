/**
 * Start Memloom Desktop using signed Node + Microsoft Edge `--app` mode.
 *
 * Ensures `dist/desktop-app/` (including `local-launcher.mjs` and
 * `renderer/local-bridge.js`) is built before launching.
 *
 * Usage: `node scripts/start-desktop.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDesktopApp } from './build-desktop.mjs'
import { buildDesktopBundledPlugins } from './build-desktop-plugins.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = resolve(root, 'dist/desktop-app')
const launcherPath = resolve(appDir, 'local-launcher.mjs')
const bridgePath = resolve(appDir, 'renderer/local-bridge.js')
const bundledManifestPath = resolve(root, 'dist/desktop-bundled-plugins/manifest.json')

if (!existsSync(launcherPath) || !existsSync(bridgePath)) {
  await buildDesktopApp()
}

let bundledNeedsBuild = !existsSync(bundledManifestPath)
if (!bundledNeedsBuild) {
  try {
    const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(bundledManifestPath, 'utf8'))
    if (manifest?.version !== rootPkg?.version) {
      bundledNeedsBuild = true
    }
  } catch {
    bundledNeedsBuild = true
  }
}
if (bundledNeedsBuild) {
  await buildDesktopBundledPlugins()
}

const launcher = await import(pathToFileURL(launcherPath).href)
await launcher.launchLocalDesktop({
  rendererDir: resolve(appDir, 'renderer'),
  onReady(url) {
    console.log(`Memloom Desktop 已启动 / listening at: ${url}`)
    console.log('正在打开 Edge 独立应用窗口（若窗口未置前，请检查任务栏或直接访问上方地址）。')
    console.log('服务保持运行中；关闭应用窗口或按 Ctrl+C 即可退出。')
  },
})
