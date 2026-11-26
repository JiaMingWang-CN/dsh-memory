/**
 * Electron Renderer entry point mounting {@link DesktopApp} into `#root`.
 * @module memloom/desktop/renderer
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopApp } from './DesktopApp.tsx'

const h = React.createElement

if (typeof document !== 'undefined') {
  const rootEl = document.getElementById('root')
  if (rootEl !== null) {
    createRoot(rootEl).render(h(DesktopApp))
  }
}
