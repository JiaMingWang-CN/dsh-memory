/**
 * Top-level Memloom Desktop React shell: client switcher topbar, DSH concurrency
 * write-guard banners + risk confirmation modal, legacy store quick-add bar,
 * external-change refresh banner, theme/locale synchronization, and routing
 * between All-Clients AggregateView and SingleClientView.
 * @module memloom/desktop/renderer/DesktopApp
 */
import * as React from 'react'
import { t, formatMessage } from '../../client/locales.ts'
import { MEMORY_CSS, MemoryErrorState, MemoryLoadingState } from '../../client/styles.ts'
import { Banner, Button, Modal } from '../../client/ui.tsx'
import type { MemoryRecord } from '../../shared/types.ts'
import type { DesktopAppInfo, DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientInfo, MigrationSourceSelection } from '../multi-service.ts'
import type { DesktopPreferences } from '../registry.ts'
import type { WriteGuardSnapshot } from '../write-guard.ts'
import { AggregateView } from './AggregateView.tsx'
import { ClientManageModal } from './ClientManageModal.tsx'
import { MigrationWizardModal } from './MigrationWizardModal.tsx'
import { SingleClientView } from './SingleClientView.tsx'
import {
  applyDesktopLocale,
  desktopErrorText,
  unwrapIpc,
  type DesktopLocale,
} from './desktop-locales.ts'

const h = React.createElement
const Fragment = React.Fragment

export interface DesktopAppProps {
  readonly bridge?: DesktopBridgeApi
}

type ActiveView = 'aggregate' | string

type DesktopModal =
  | { readonly kind: 'addClient' }
  | { readonly kind: 'editClient'; readonly client: DesktopClientInfo }
  | {
      readonly kind: 'migrate'
      readonly sourceClientId?: string
      readonly selection?: MigrationSourceSelection
    }
  | { readonly kind: 'confirmUnlock' }

function resolveTheme(
  pref: DesktopPreferences['theme'],
  appInfo?: DesktopAppInfo,
): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref
  if (appInfo?.systemTheme === 'dark' || appInfo?.systemTheme === 'light') {
    return appInfo.systemTheme
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function clientPillStatusLabel(client: DesktopClientInfo): {
  text: string
  tone: 'success' | 'warn' | 'error' | 'idle'
} {
  if (!client.enabled) return { text: t('desktop.status.disabled'), tone: 'idle' }
  if (client.health === 'corrupted') return { text: t('desktop.status.corrupted'), tone: 'error' }
  if (client.health === 'unreadable') return { text: t('desktop.status.unreadable'), tone: 'error' }
  if (client.health === 'missing') return { text: t('desktop.status.missing'), tone: 'idle' }
  if (client.writable) {
    return {
      text: client.dshProtected ? t('desktop.status.forceUnlocked') : t('desktop.status.writable'),
      tone: client.dshProtected ? 'warn' : 'success',
    }
  }
  return { text: t('desktop.status.readonly'), tone: 'warn' }
}

function BrandLogo(): React.ReactElement {
  return h(
    'svg',
    {
      viewBox: '0 0 128 128',
      width: 28,
      height: 28,
      className: 'memloom-brand-logo',
      'aria-hidden': true,
    },
    h(
      'defs',
      null,
      h(
        'linearGradient',
        {
          id: 'memloom-brand-grad',
          x1: '0',
          y1: '0',
          x2: '128',
          y2: '128',
          gradientUnits: 'userSpaceOnUse',
        },
        h('stop', { offset: '0', stopColor: '#4f6df5' }),
        h('stop', { offset: '1', stopColor: '#7a3ff2' }),
      ),
    ),
    h('rect', { x: 4, y: 4, width: 120, height: 120, rx: 28, fill: 'url(#memloom-brand-grad)' }),
    h(
      'g',
      {
        fill: 'none',
        stroke: '#ffffff',
        strokeWidth: 4.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        opacity: 0.96,
      },
      h('path', {
        d: 'M64 34c-13 0-22 9-22 21 0 5 2 9 5 12-3 3-4 7-4 11 0 8 6 14 14 14h14c8 0 14-6 14-14 0-4-1-8-4-11 3-3 5-7 5-12 0-12-9-21-22-21z',
      }),
      h('path', { d: 'M64 34v58' }),
      h('path', { d: 'M50 52h8M70 52h8M48 70h8M72 70h8' }),
    ),
    h(
      'g',
      { fill: '#ffffff' },
      h('circle', { cx: 64, cy: 34, r: 5 }),
      h('circle', { cx: 50, cy: 52, r: 4 }),
      h('circle', { cx: 78, cy: 52, r: 4 }),
      h('circle', { cx: 48, cy: 70, r: 4 }),
      h('circle', { cx: 80, cy: 70, r: 4 }),
      h('circle', { cx: 64, cy: 92, r: 4 }),
    ),
  )
}

function AllClientsIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
    h('rect', {
      x: 2,
      y: 2,
      width: 5,
      height: 5,
      rx: 1.2,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('rect', {
      x: 9,
      y: 2,
      width: 5,
      height: 5,
      rx: 1.2,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('rect', {
      x: 2,
      y: 9,
      width: 5,
      height: 5,
      rx: 1.2,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('rect', {
      x: 9,
      y: 9,
      width: 5,
      height: 5,
      rx: 1.2,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
  )
}

function PlatformIcon(props: { readonly kind: DesktopClientInfo['kind'] }): React.ReactElement {
  if (props.kind === 'dsh') {
    return h(
      'svg',
      { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
      h('path', {
        d: 'M8 2.2 13 4.8v6.4L8 13.8 3 11.2V4.8L8 2.2Z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinejoin: 'round',
      }),
      h('circle', { cx: 8, cy: 8, r: 1.8, fill: 'currentColor' }),
    )
  }
  if (props.kind === 'agy') {
    return h(
      'svg',
      { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
      h('path', {
        d: 'M8 2.3 13.2 12.8 8 10.2 2.8 12.8 8 2.3Z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinejoin: 'round',
      }),
    )
  }
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
    h('path', {
      d: 'M2.5 5.2c0-.9 2.5-1.7 5.5-1.7s5.5.8 5.5 1.7v5.6c0 .9-2.5 1.7-5.5 1.7s-5.5-.8-5.5-1.7V5.2Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
    }),
    h('path', {
      d: 'M2.5 8c0 .9 2.5 1.7 5.5 1.7s5.5-.8 5.5-1.7',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
    }),
  )
}

function ThemeIcon(props: { readonly isDark: boolean }): React.ReactElement {
  if (props.isDark) {
    return h(
      'svg',
      { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 3.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', {
        d: 'M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
      }),
    )
  }
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
    h('path', {
      d: 'M12.9 10.1A5.2 5.2 0 0 1 5.9 3.1a5.3 5.3 0 1 0 7 7Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinejoin: 'round',
    }),
  )
}

function MigrateIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
    h('path', {
      d: 'M3 5.5h9.5m0 0L9.8 2.8m2.7 2.7L9.8 8.2M13 10.5H3.5m0 0 2.7-2.7m-2.7 2.7 2.7 2.7',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/**
 * Root React component for Memloom Desktop.
 */
export function DesktopApp(props?: DesktopAppProps): React.ReactElement
export function DesktopApp(props: DesktopAppProps): React.ReactElement
export function DesktopApp(props: DesktopAppProps = {}): React.ReactElement {
  const bridge =
    props?.bridge ?? (typeof window !== 'undefined' ? window.memloomDesktop : undefined)

  const [locale, setLocale] = React.useState<DesktopLocale>(() => {
    applyDesktopLocale('zh')
    return 'zh'
  })
  const [themePref, setThemePref] = React.useState<DesktopPreferences['theme']>('system')
  const [appInfo, setAppInfo] = React.useState<DesktopAppInfo | undefined>(undefined)

  const [clients, setClients] = React.useState<DesktopClientInfo[]>([])
  const [guardSnapshot, setGuardSnapshot] = React.useState<WriteGuardSnapshot | undefined>(
    undefined,
  )
  const [legacyCandidate, setLegacyCandidate] = React.useState<string | null>(null)
  const [legacyDismissed, setLegacyDismissed] = React.useState(false)
  const [activeView, setActiveView] = React.useState<ActiveView>('aggregate')

  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [bannerError, setBannerError] = React.useState('')
  const [externalChanged, setExternalChanged] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [modal, setModal] = React.useState<DesktopModal | undefined>(undefined)
  const [guardBusy, setGuardBusy] = React.useState(false)

  const openMemorySeq = React.useRef(0)
  const [openMemoryReq, setOpenMemoryReq] = React.useState<
    { readonly clientId: string; readonly id: string; readonly seq: number } | undefined
  >(undefined)

  // Synchronize document data-theme whenever resolved theme changes
  const resolvedTheme = resolveTheme(themePref, appInfo)
  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = resolvedTheme
    }
  }, [resolvedTheme])

  const loadAll = React.useCallback(
    async (selectFirstIfEmpty = false): Promise<void> => {
      if (bridge === undefined) return
      setLoadError('')
      try {
        const [clientsRes, guardRes, prefsRes, infoRes, legacyRes] = await Promise.all([
          bridge.clients.list(),
          bridge.clients.getGuardSnapshot(),
          bridge.app.getPreferences(),
          bridge.app.getInfo(),
          bridge.clients.getLegacyAgyCandidate(),
        ])
        const nextClients = unwrapIpc(clientsRes)
        const nextGuard = unwrapIpc(guardRes)
        const nextPrefs = unwrapIpc(prefsRes)
        const nextInfo = unwrapIpc(infoRes)
        const nextLegacy = unwrapIpc(legacyRes)

        applyDesktopLocale(nextPrefs.locale)
        setLocale(nextPrefs.locale)
        setThemePref(nextPrefs.theme)
        setAppInfo(nextInfo)
        setClients(nextClients)
        setGuardSnapshot(nextGuard)
        setLegacyCandidate(nextLegacy)

        if (selectFirstIfEmpty && nextClients.length > 0) {
          setActiveView((cur) => (cur === 'aggregate' ? nextClients[0]!.id : cur))
        }
      } catch (reason) {
        setLoadError(desktopErrorText(reason))
      } finally {
        setLoading(false)
      }
    },
    [bridge],
  )

  React.useEffect(() => {
    if (bridge === undefined) {
      setLoading(false)
      return undefined
    }
    void loadAll(true)
    const unsubscribe = bridge.app.onFocusRefresh(() => {
      void bridge.clients
        .refreshAll()
        .then(async (res) => {
          setClients(unwrapIpc(res))
          setGuardSnapshot(unwrapIpc(await bridge.clients.getGuardSnapshot()))
          setRefreshToken((v) => v + 1)
        })
        .catch(() => undefined)
    })
    return unsubscribe
  }, [bridge, loadAll])

  const refreshClientsAndGuard = React.useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    setGuardBusy(true)
    setBannerError('')
    try {
      const clientsRes = unwrapIpc(await bridge.clients.refreshAll())
      const guardRes = unwrapIpc(await bridge.clients.getGuardSnapshot())
      setClients(clientsRes)
      setGuardSnapshot(guardRes)
      setExternalChanged(false)
      setRefreshToken((v) => v + 1)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    } finally {
      setGuardBusy(false)
    }
  }, [bridge])

  const recheckGuard = async (): Promise<void> => {
    if (bridge === undefined) return
    setGuardBusy(true)
    setBannerError('')
    try {
      const nextGuard = unwrapIpc(await bridge.clients.refreshDshGuard())
      const nextClients = unwrapIpc(await bridge.clients.list())
      setGuardSnapshot(nextGuard)
      setClients(nextClients)
      setRefreshToken((v) => v + 1)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    } finally {
      setGuardBusy(false)
    }
  }

  const confirmForceUnlock = async (): Promise<void> => {
    if (bridge === undefined) return
    setGuardBusy(true)
    setBannerError('')
    try {
      const nextGuard = unwrapIpc(await bridge.clients.forceUnlockDsh({ confirmed: true }))
      const nextClients = unwrapIpc(await bridge.clients.list())
      setGuardSnapshot(nextGuard)
      setClients(nextClients)
      setModal(undefined)
      setRefreshToken((v) => v + 1)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    } finally {
      setGuardBusy(false)
    }
  }

  const relockGuard = async (): Promise<void> => {
    if (bridge === undefined) return
    setGuardBusy(true)
    setBannerError('')
    try {
      const nextGuard = unwrapIpc(await bridge.clients.relockDsh())
      const nextClients = unwrapIpc(await bridge.clients.list())
      setGuardSnapshot(nextGuard)
      setClients(nextClients)
      setRefreshToken((v) => v + 1)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    } finally {
      setGuardBusy(false)
    }
  }

  const toggleLocale = async (): Promise<void> => {
    const nextLocale: DesktopLocale = locale === 'zh' ? 'en' : 'zh'
    applyDesktopLocale(nextLocale)
    setLocale(nextLocale)
    if (bridge !== undefined) {
      try {
        await bridge.app.updatePreferences({ locale: nextLocale })
      } catch {
        // Keep active UI language even if persistence rejects
      }
    }
  }

  const toggleTheme = async (): Promise<void> => {
    const nextTheme: 'light' | 'dark' = resolvedTheme === 'dark' ? 'light' : 'dark'
    setThemePref(nextTheme)
    if (bridge !== undefined) {
      try {
        await bridge.app.updatePreferences({ theme: nextTheme })
      } catch {
        // Keep active UI theme
      }
    }
  }

  const quickAddLegacy = async (): Promise<void> => {
    if (bridge === undefined || legacyCandidate === null) return
    setBannerError('')
    try {
      const added = unwrapIpc(
        await bridge.clients.add({
          name: t('desktop.legacy.defaultName'),
          storePath: legacyCandidate,
          dshProtected: false,
        }),
      )
      setLegacyCandidate(null)
      setLegacyDismissed(true)
      const nextClients = unwrapIpc(await bridge.clients.list())
      setClients(nextClients)
      setActiveView(added.id)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    }
  }

  if (bridge === undefined) {
    return h(
      'div',
      { className: 'memloom-shell' },
      h('style', null, MEMORY_CSS),
      h(
        'main',
        { className: 'memloom-workspace' },
        h(
          'div',
          { className: 'memloom-content-scroll' },
          h(
            'div',
            { className: 'memloom-content-inner' },
            h(MemoryErrorState, { message: 'window.memloomDesktop bridge is not available.' }),
          ),
        ),
      ),
    )
  }

  const activeClient =
    activeView === 'aggregate'
      ? undefined
      : (clients.find((client) => client.id === activeView) ?? clients[0])

  const hasProtectedClient = clients.some((client) => client.dshProtected)
  const showGuardBanner =
    guardSnapshot !== undefined &&
    hasProtectedClient &&
    (guardSnapshot.mode === 'readonly-dsh-running' || guardSnapshot.mode === 'force-unlocked') &&
    (activeClient === undefined ||
      activeClient.dshProtected ||
      guardSnapshot.mode === 'force-unlocked')

  const enabledCount = clients.filter((client) => client.enabled).length

  const hasBanners =
    (showGuardBanner && guardSnapshot !== undefined) ||
    externalChanged ||
    (legacyCandidate !== null && !legacyDismissed) ||
    bannerError !== ''

  const bannersNode = !hasBanners
    ? null
    : h(
        'div',
        { className: 'memloom-banners' },
        showGuardBanner && guardSnapshot !== undefined
          ? h(
              'div',
              {
                className: 'memloom-guard-banner',
                'data-mode': guardSnapshot.mode,
                role: 'status',
              },
              h(
                'span',
                null,
                guardSnapshot.mode === 'force-unlocked'
                  ? t('desktop.guard.forceUnlockedBanner')
                  : guardSnapshot.uncertain
                    ? t('desktop.guard.uncertainBanner')
                    : t('desktop.guard.runningBanner'),
              ),
              h(
                'div',
                { className: 'dsh-mem-actions' },
                h(
                  Button,
                  {
                    size: 'sm',
                    disabled: guardBusy,
                    onClick: () => {
                      void recheckGuard()
                    },
                  },
                  t('desktop.guard.recheck'),
                ),
                guardSnapshot.mode === 'readonly-dsh-running'
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'danger',
                        disabled: guardBusy,
                        onClick: () => setModal({ kind: 'confirmUnlock' }),
                      },
                      t('desktop.guard.forceUnlock'),
                    )
                  : h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'primary',
                        disabled: guardBusy,
                        onClick: () => {
                          void relockGuard()
                        },
                      },
                      t('desktop.guard.relock'),
                    ),
              ),
            )
          : null,

        externalChanged
          ? h(
              'div',
              { className: 'memloom-external-banner', role: 'alert' },
              h('span', null, t('desktop.externalChange.banner')),
              h(
                Button,
                {
                  size: 'sm',
                  variant: 'danger',
                  disabled: guardBusy,
                  onClick: () => {
                    void refreshClientsAndGuard()
                  },
                },
                t('desktop.externalChange.refresh'),
              ),
            )
          : null,

        legacyCandidate !== null && !legacyDismissed
          ? h(
              'div',
              { className: 'memloom-legacy-banner', role: 'status' },
              h('span', null, formatMessage('desktop.legacy.banner', { path: legacyCandidate })),
              h(
                'div',
                { className: 'dsh-mem-actions' },
                h(
                  Button,
                  {
                    size: 'sm',
                    variant: 'primary',
                    onClick: () => {
                      void quickAddLegacy()
                    },
                  },
                  t('desktop.legacy.quickAdd'),
                ),
                h(
                  Button,
                  {
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => setLegacyDismissed(true),
                  },
                  t('desktop.legacy.dismiss'),
                ),
              ),
            )
          : null,

        bannerError !== ''
          ? h(Banner, { tone: 'error', message: bannerError, onDismiss: () => setBannerError('') })
          : null,
      )

  return h(
    'div',
    { className: 'memloom-shell', 'data-locale': locale, 'data-theme': resolvedTheme },
    h('style', null, MEMORY_CSS),

    // Left Platform Sidebar
    h(
      'aside',
      { className: 'memloom-sidebar' },
      h(
        'div',
        { className: 'memloom-sidebar-brand' },
        h(BrandLogo),
        h(
          'div',
          { className: 'memloom-brand-text' },
          h(
            'div',
            { className: 'memloom-brand-title-row' },
            h('span', { className: 'memloom-brand' }, t('desktop.brand')),
            appInfo?.version
              ? h('span', { className: 'memloom-brand-version' }, `v${appInfo.version}`)
              : null,
          ),
          h('span', { className: 'memloom-brand-sub' }, t('desktop.brandSub')),
        ),
      ),

      h(
        'nav',
        {
          className: 'memloom-sidebar-nav',
          'aria-label': t('desktop.sidebar.platformListLabel'),
        },
        h(
          'div',
          { className: 'memloom-sidebar-group' },
          h('div', { className: 'memloom-sidebar-heading' }, t('desktop.sidebar.overview')),
          h(
            'button',
            {
              type: 'button',
              className: 'memloom-nav-item',
              ...(activeView === 'aggregate' ? { 'aria-current': 'page' } : {}),
              onClick: () => setActiveView('aggregate'),
            },
            h('span', { className: 'memloom-nav-icon', 'data-kind': 'all' }, h(AllClientsIcon)),
            h(
              'span',
              { className: 'memloom-nav-body' },
              h('span', { className: 'memloom-nav-title' }, t('desktop.allClients')),
              h(
                'span',
                { className: 'memloom-nav-meta' },
                formatMessage('desktop.sidebar.storeCount', { count: enabledCount }),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'memloom-sidebar-group' },
          h(
            'div',
            { className: 'memloom-sidebar-heading-row' },
            h('span', { className: 'memloom-sidebar-heading' }, t('desktop.sidebar.platforms')),
            h('span', { className: 'memloom-sidebar-count' }, String(clients.length)),
          ),
          ...clients.map((client) => {
            const st = clientPillStatusLabel(client)
            const selected = activeClient?.id === client.id && activeView !== 'aggregate'
            return h(
              'button',
              {
                key: client.id,
                type: 'button',
                className: 'memloom-nav-item',
                ...(selected ? { 'aria-current': 'page' } : {}),
                onClick: () => setActiveView(client.id),
              },
              h(
                'span',
                { className: 'memloom-nav-icon', 'data-kind': client.kind },
                h(PlatformIcon, { kind: client.kind }),
              ),
              h(
                'span',
                { className: 'memloom-nav-body' },
                h('span', { className: 'memloom-nav-title' }, client.name),
                h(
                  'span',
                  { className: 'memloom-nav-meta' },
                  h('span', { className: 'dsh-mem-dot', 'data-tone': st.tone }),
                  h('span', null, st.text),
                  h('span', { className: 'memloom-nav-kind' }, t(`desktop.kind.${client.kind}`)),
                ),
              ),
            )
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'memloom-sidebar-add',
              onClick: () => setModal({ kind: 'addClient' }),
            },
            t('desktop.addClient'),
          ),
        ),
      ),

      h(
        'div',
        { className: 'memloom-sidebar-footer' },
        clients.length >= 2
          ? h(
              'button',
              {
                type: 'button',
                className: 'memloom-sidebar-action',
                onClick: () =>
                  setModal({
                    kind: 'migrate',
                    ...(activeClient !== undefined ? { sourceClientId: activeClient.id } : {}),
                  }),
              },
              h(MigrateIcon),
              h('span', null, t('desktop.migrateQuick')),
            )
          : null,
        h(
          'div',
          { className: 'memloom-sidebar-prefs' },
          h(
            'button',
            {
              type: 'button',
              className: 'memloom-sidebar-pref-btn',
              onClick: () => {
                void toggleLocale()
              },
            },
            t('desktop.langToggle'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'memloom-sidebar-pref-btn',
              onClick: () => {
                void toggleTheme()
              },
            },
            h(ThemeIcon, { isDark: resolvedTheme === 'dark' }),
            h(
              'span',
              null,
              resolvedTheme === 'dark'
                ? t('desktop.themeSwitchToLight')
                : t('desktop.themeSwitchToDark'),
            ),
          ),
        ),
      ),
    ),

    // Right Memory Workspace
    h(
      'main',
      { className: 'memloom-workspace' },
      loading
        ? h(
            Fragment,
            null,
            bannersNode,
            h(
              'div',
              { className: 'memloom-content-scroll' },
              h('div', { className: 'memloom-content-inner' }, h(MemoryLoadingState)),
            ),
          )
        : loadError !== ''
          ? h(
              Fragment,
              null,
              bannersNode,
              h(
                'div',
                { className: 'memloom-content-scroll' },
                h(
                  'div',
                  { className: 'memloom-content-inner' },
                  h(MemoryErrorState, { message: loadError, onRetry: () => void loadAll(false) }),
                ),
              ),
            )
          : activeView === 'aggregate' || activeClient === undefined
            ? h(AggregateView, {
                bridge,
                clients,
                refreshToken,
                banners: bannersNode,
                onOpenInClient: (clientId, record) => {
                  const seq = ++openMemorySeq.current
                  setOpenMemoryReq({ clientId, id: record.id, seq })
                  setActiveView(clientId)
                },
                onMigrateRecord: (clientId, record) => {
                  setModal({
                    kind: 'migrate',
                    sourceClientId: clientId,
                    selection: { kind: 'records', memoryIds: [record.id] },
                  })
                },
              })
            : h(SingleClientView, {
                bridge,
                client: activeClient,
                refreshToken,
                banners: bannersNode,
                ...(openMemoryReq !== undefined && openMemoryReq.clientId === activeClient.id
                  ? { openMemoryRequest: { id: openMemoryReq.id, seq: openMemoryReq.seq } }
                  : {}),
                onClientDataChanged: async () => {
                  const nextClients = unwrapIpc(await bridge.clients.list())
                  setClients(nextClients)
                },
                onOpenMigrationForRecord: (clientId, record: MemoryRecord) => {
                  setModal({
                    kind: 'migrate',
                    sourceClientId: clientId,
                    selection: { kind: 'records', memoryIds: [record.id] },
                  })
                },
                onOpenMigrationWizard: (clientId) => {
                  setModal({ kind: 'migrate', sourceClientId: clientId })
                },
                onExternalChange: () => setExternalChanged(true),
                onManageClient: (target) => setModal({ kind: 'editClient', client: target }),
              }),
    ),

    // Modals
    modal === undefined
      ? null
      : modal.kind === 'addClient'
        ? h(ClientManageModal, {
            bridge,
            onClose: () => setModal(undefined),
            onSaved: async (clientId) => {
              setModal(undefined)
              const nextClients = unwrapIpc(await bridge.clients.list())
              setClients(nextClients)
              if (clientId !== undefined) {
                setActiveView(clientId)
              }
            },
          })
        : modal.kind === 'editClient'
          ? h(ClientManageModal, {
              bridge,
              client: modal.client,
              onClose: () => setModal(undefined),
              onSaved: async (clientId) => {
                setModal(undefined)
                const nextClients = unwrapIpc(await bridge.clients.list())
                setClients(nextClients)
                if (clientId === undefined) {
                  setActiveView('aggregate')
                }
              },
            })
          : modal.kind === 'migrate'
            ? h(MigrationWizardModal, {
                bridge,
                clients,
                ...(modal.sourceClientId !== undefined
                  ? { initialSourceClientId: modal.sourceClientId }
                  : {}),
                ...(modal.selection !== undefined ? { initialSelection: modal.selection } : {}),
                onClose: () => setModal(undefined),
                onSuccess: async () => {
                  const nextClients = unwrapIpc(await bridge.clients.list())
                  setClients(nextClients)
                  setRefreshToken((v) => v + 1)
                },
                onExternalChange: () => setExternalChanged(true),
              })
            : h(
                Modal,
                {
                  title: t('desktop.guard.unlockTitle'),
                  onClose: () => setModal(undefined),
                  closeLabel: t('common.close'),
                  footer: h(
                    Fragment,
                    null,
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        disabled: guardBusy,
                        onClick: () => setModal(undefined),
                      },
                      t('common.cancel'),
                    ),
                    h(
                      Button,
                      {
                        variant: 'danger',
                        disabled: guardBusy,
                        onClick: () => {
                          void confirmForceUnlock()
                        },
                      },
                      t('desktop.guard.unlockConfirm'),
                    ),
                  ),
                },
                h(
                  'div',
                  { className: 'dsh-mem-confirm', role: 'alert' },
                  t('desktop.guard.unlockWarning'),
                ),
              ),
  )
}
