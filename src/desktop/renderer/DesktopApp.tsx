/**
 * Top-level Memloom Desktop React shell: dual-layer floating island workbench,
 * equal-footing DSH & AGY host rail, DSH write-guard state synchronization,
 * Ctrl+K command palette, bilingual/theme preferences, and toast notifications.
 * @module memloom/desktop/renderer/DesktopApp
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { DesktopAppInfo, DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientInfo, MigrationSourceSelection } from '../multi-service.ts'
import type { DesktopPreferences } from '../registry.ts'
import type { WriteGuardSnapshot } from '../write-guard.ts'
import { DesktopConfigPanel } from './DesktopConfigPanel.tsx'
import { DreamAuditPanel } from './DreamAuditPanel.tsx'
import { MemoriesView } from './MemoriesView.tsx'
import { MigrationView } from './MigrationView.tsx'
import { ReviewView } from './ReviewView.tsx'
import {
  applyDesktopLocale,
  desktopErrorText,
  unwrapIpc,
  type DesktopLocale,
} from './desktop-locales.ts'
import {
  Button,
  EmptyBlock,
  HostLogo,
  Icons,
  LogoHorizontal,
  Modal,
  SegmentedControl,
  ToastHost,
  type ToastEntry,
} from './ui.tsx'

const h = React.createElement

export interface DesktopAppProps {
  readonly bridge?: DesktopBridgeApi
}

export type AppRoute = 'memories' | 'review' | 'migrate' | 'audit' | 'config'

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

function isClientUnhealthy(client: DesktopClientInfo): boolean {
  return !client.enabled || client.health === 'corrupted' || client.health === 'unreadable'
}

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

  const [route, setRoute] = React.useState<AppRoute>('memories')
  const [activeHostId, setActiveHostId] = React.useState<string | 'all'>('all')
  const [hostCounts, setHostCounts] = React.useState<Record<string, number>>({})
  const [pendingTotal, setPendingTotal] = React.useState(0)

  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [bannerError, setBannerError] = React.useState('')
  const [externalChanged, setExternalChanged] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [unlockModalOpen, setUnlockModalOpen] = React.useState(false)
  const [guardBusy, setGuardBusy] = React.useState(false)

  const [migrateReq, setMigrateReq] = React.useState<{
    readonly sourceClientId?: string
    readonly selection?: MigrationSourceSelection
  }>({})
  const openMemorySeq = React.useRef(0)
  const [openMemoryReq, setOpenMemoryReq] = React.useState<
    { readonly clientId: string; readonly id: string; readonly seq: number } | undefined
  >(undefined)

  const [cmdOpen, setCmdOpen] = React.useState(false)
  const [toasts, setToasts] = React.useState<ToastEntry[]>([])
  const toastTimersRef = React.useRef<Set<number>>(new Set())

  React.useEffect(() => {
    const timers = toastTimersRef.current
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const notify = React.useCallback((message: string, tone: ToastEntry['tone'] = 'info'): void => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((cur) => [...cur.slice(-3), { id, message, tone }])
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(timer)
      setToasts((cur) => cur.filter((item) => item.id !== id))
    }, 2800)
    toastTimersRef.current.add(timer)
  }, [])

  const resolvedTheme = resolveTheme(themePref, appInfo)
  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = resolvedTheme
    }
  }, [resolvedTheme])

  const loadHostStats = React.useCallback(
    async (list: readonly DesktopClientInfo[]): Promise<void> => {
      if (bridge === undefined) return
      const counts: Record<string, number> = {}
      let pendingSum = 0
      let allSucceeded = true
      await Promise.all(
        list.map(async (c) => {
          if (!c.enabled || c.health !== 'ready') return
          try {
            const ov = unwrapIpc(
              await bridge.memory.overview({ clientId: c.id, workspaceKey: 'all' }),
            )
            counts[c.id] = ov.counts.stored
            pendingSum += ov.counts.pending
          } catch {
            allSucceeded = false
          }
        }),
      )
      setHostCounts(counts)
      if (allSucceeded) {
        setPendingTotal(pendingSum)
      }
    },
    [bridge],
  )

  const loadAll = React.useCallback(async (): Promise<void> => {
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
      await loadHostStats(nextClients)
    } catch (reason) {
      setLoadError(desktopErrorText(reason))
    } finally {
      setLoading(false)
    }
  }, [bridge, loadHostStats])

  React.useEffect(() => {
    if (bridge === undefined) {
      setLoading(false)
      return undefined
    }
    void loadAll()
    const unsubscribe = bridge.app.onFocusRefresh(() => {
      void bridge.clients
        .refreshAll()
        .then(async (res) => {
          const next = unwrapIpc(res)
          setClients(next)
          setGuardSnapshot(unwrapIpc(await bridge.clients.getGuardSnapshot()))
          await loadHostStats(next)
          setRefreshToken((v) => v + 1)
        })
        .catch(() => undefined)
    })
    return unsubscribe
  }, [bridge, loadAll, loadHostStats])

  const syncAfterDataChange = React.useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    try {
      const nextClients = unwrapIpc(await bridge.clients.list())
      setClients(nextClients)
      await loadHostStats(nextClients)
    } catch {
      // Ignore secondary count sync failures
    }
  }, [bridge, loadHostStats])

  const refreshClientsAndGuard = React.useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    setGuardBusy(true)
    setBannerError('')
    try {
      const nextClients = unwrapIpc(await bridge.clients.refreshAll())
      const nextGuard = unwrapIpc(await bridge.clients.getGuardSnapshot())
      setClients(nextClients)
      setGuardSnapshot(nextGuard)
      setExternalChanged(false)
      await loadHostStats(nextClients)
      setRefreshToken((v) => v + 1)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    } finally {
      setGuardBusy(false)
    }
  }, [bridge, loadHostStats])

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
      notify(t('desktop.guard.recheck'), 'info')
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
      setUnlockModalOpen(false)
      setRefreshToken((v) => v + 1)
      notify(t('desktop.status.forceUnlocked'), 'warn')
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
      notify(t('desktop.status.readonly'), 'success')
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

  const setTheme = async (nextTheme: 'light' | 'dark'): Promise<void> => {
    setThemePref(nextTheme)
    if (bridge !== undefined) {
      try {
        await bridge.app.updatePreferences({ theme: nextTheme })
      } catch {
        // Keep active theme
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
      await loadHostStats(nextClients)
      setRoute('memories')
      setActiveHostId(added.id)
    } catch (reason) {
      setBannerError(desktopErrorText(reason))
    }
  }

  // Global Ctrl+K / Cmd+K Command Palette
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCmdOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (bridge === undefined) {
    return h(
      'div',
      { className: 'memloom-shell', 'data-theme': resolvedTheme },
      h(
        'main',
        { className: 'memloom-stage' },
        h(EmptyBlock, {
          icon: Icons.shield(),
          title: t('state.error'),
          description: 'window.memloomDesktop bridge is not available.',
        }),
      ),
    )
  }

  const activeClient =
    activeHostId === 'all' ? undefined : clients.find((c) => c.id === activeHostId)
  const hasProtectedClient = clients.some((c) => c.dshProtected)
  const showGuardBanner =
    route !== 'config' &&
    guardSnapshot !== undefined &&
    hasProtectedClient &&
    (guardSnapshot.mode === 'readonly-dsh-running' || guardSnapshot.mode === 'force-unlocked') &&
    (activeClient === undefined ||
      activeClient.dshProtected ||
      guardSnapshot.mode === 'force-unlocked')

  const hasBanners =
    (showGuardBanner && guardSnapshot !== undefined) ||
    externalChanged ||
    (legacyCandidate !== null && !legacyDismissed) ||
    bannerError !== ''

  const bannersNode = !hasBanners
    ? null
    : h(
        React.Fragment,
        null,
        showGuardBanner && guardSnapshot !== undefined
          ? h(
              'div',
              { className: 'ml-banner', 'data-tone': 'warn', role: 'status' },
              h(
                'div',
                { className: 'ml-banner-main' },
                h(
                  'span',
                  { style: { color: 'var(--ml-warn)', display: 'inline-flex' } },
                  Icons.shield(),
                ),
                h(
                  'span',
                  null,
                  guardSnapshot.mode === 'force-unlocked'
                    ? t('desktop.guard.forceUnlockedBanner')
                    : guardSnapshot.uncertain
                      ? t('desktop.guard.uncertainBanner')
                      : t('desktop.guard.runningBanner'),
                ),
              ),
              h(
                'div',
                { className: 'ml-banner-actions' },
                h(
                  Button,
                  { size: 'sm', disabled: guardBusy, onClick: () => void recheckGuard() },
                  Icons.refresh(),
                  h('span', null, t('desktop.guard.recheck')),
                ),
                guardSnapshot.mode === 'readonly-dsh-running'
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'warn',
                        disabled: guardBusy,
                        onClick: () => setUnlockModalOpen(true),
                      },
                      t('desktop.guard.forceUnlock'),
                    )
                  : h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'primary',
                        disabled: guardBusy,
                        onClick: () => void relockGuard(),
                      },
                      t('desktop.guard.relock'),
                    ),
              ),
            )
          : null,

        externalChanged
          ? h(
              'div',
              { className: 'ml-banner', 'data-tone': 'danger', role: 'alert' },
              h('span', null, t('desktop.externalChange.banner')),
              h(
                Button,
                {
                  size: 'sm',
                  variant: 'danger',
                  disabled: guardBusy,
                  onClick: () => void refreshClientsAndGuard(),
                },
                t('desktop.externalChange.refresh'),
              ),
            )
          : null,

        legacyCandidate !== null && !legacyDismissed
          ? h(
              'div',
              { className: 'ml-banner', 'data-tone': 'info', role: 'status' },
              h('span', null, formatMessage('desktop.legacy.banner', { path: legacyCandidate })),
              h(
                'div',
                { className: 'ml-banner-actions' },
                h(
                  Button,
                  { size: 'sm', variant: 'primary', onClick: () => void quickAddLegacy() },
                  t('desktop.legacy.quickAdd'),
                ),
                h(
                  Button,
                  { size: 'sm', variant: 'ghost', onClick: () => setLegacyDismissed(true) },
                  t('desktop.legacy.dismiss'),
                ),
              ),
            )
          : null,

        bannerError !== ''
          ? h(
              'div',
              { className: 'ml-banner', 'data-tone': 'danger', role: 'alert' },
              h('span', null, bannerError),
              h(
                Button,
                { size: 'sm', variant: 'ghost', onClick: () => setBannerError('') },
                t('common.close'),
              ),
            )
          : null,
      )

  const totalActiveCount = Object.values(hostCounts).reduce((acc, n) => acc + n, 0)

  return h(
    'div',
    { className: 'memloom-shell', 'data-locale': locale, 'data-theme': resolvedTheme },

    // Left Quiet Navigation Rail
    h(
      'aside',
      { className: 'memloom-rail' },
      h(
        'div',
        { className: 'memloom-rail-top' },
        h(
          'div',
          { className: 'memloom-brand-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'memloom-brand-btn',
              title: t('desktop.nav.memories'),
              onClick: () => {
                setRoute('memories')
                setActiveHostId('all')
              },
            },
            h(LogoHorizontal, { theme: resolvedTheme }),
          ),
          appInfo?.version !== undefined
            ? h('span', { className: 'memloom-version-tag' }, `v${appInfo.version}`)
            : null,
        ),

        h(
          'nav',
          {
            className: 'memloom-rail-nav ml-scroll',
            'aria-label': t('desktop.sidebar.platformListLabel'),
          },
          // Workspace Views
          h(
            'div',
            { className: 'memloom-rail-section' },
            h(
              'div',
              { className: 'memloom-rail-heading-row' },
              h('span', { className: 'memloom-rail-heading' }, t('desktop.sidebar.overview')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ml-nav-pill',
                ...(route === 'memories' && activeHostId === 'all'
                  ? { 'aria-current': 'page' }
                  : {}),
                onClick: () => {
                  setRoute('memories')
                  setActiveHostId('all')
                },
              },
              h(
                'span',
                { className: 'ml-nav-pill-left' },
                h(
                  'span',
                  {
                    style: {
                      color:
                        route === 'memories' && activeHostId === 'all'
                          ? 'var(--ml-copper)'
                          : 'var(--ml-text-muted)',
                      display: 'inline-flex',
                    },
                  },
                  Icons.layers(),
                ),
                h('span', { className: 'ml-nav-label' }, t('desktop.nav.memories')),
              ),
              totalActiveCount > 0
                ? h('span', { className: 'ml-nav-count' }, String(totalActiveCount))
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ml-nav-pill',
                ...(route === 'review' ? { 'aria-current': 'page' } : {}),
                onClick: () => setRoute('review'),
              },
              h(
                'span',
                { className: 'ml-nav-pill-left' },
                h(
                  'span',
                  {
                    style: {
                      color: route === 'review' ? 'var(--ml-copper)' : 'var(--ml-text-muted)',
                      display: 'inline-flex',
                    },
                  },
                  Icons.inbox(),
                ),
                h('span', { className: 'ml-nav-label' }, t('desktop.nav.review')),
              ),
              pendingTotal > 0
                ? h('span', { className: 'ml-nav-badge' }, String(pendingTotal))
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ml-nav-pill',
                ...(route === 'migrate' ? { 'aria-current': 'page' } : {}),
                onClick: () => {
                  setMigrateReq({})
                  setRoute('migrate')
                },
              },
              h(
                'span',
                { className: 'ml-nav-pill-left' },
                h(
                  'span',
                  {
                    style: {
                      color: route === 'migrate' ? 'var(--ml-copper)' : 'var(--ml-text-muted)',
                      display: 'inline-flex',
                    },
                  },
                  Icons.migrate(),
                ),
                h('span', { className: 'ml-nav-label' }, t('desktop.nav.migrate')),
              ),
            ),
          ),

          // Equal-footing Connected Hosts (DSH & AGY)
          h(
            'div',
            { className: 'memloom-rail-section' },
            h(
              'div',
              { className: 'memloom-rail-heading-row' },
              h('span', { className: 'memloom-rail-heading' }, t('desktop.sidebar.platforms')),
              activeHostId !== 'all'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'memloom-rail-reset',
                      onClick: () => {
                        setRoute('memories')
                        setActiveHostId('all')
                      },
                    },
                    t('desktop.sidebar.allShort'),
                  )
                : null,
            ),
            clients.map((client) => {
              const selected = route === 'memories' && activeHostId === client.id
              const count = hostCounts[client.id]
              return h(
                'button',
                {
                  key: client.id,
                  type: 'button',
                  className: 'ml-nav-pill',
                  ...(selected ? { 'aria-current': 'page' } : {}),
                  onClick: () => {
                    setRoute('memories')
                    setActiveHostId(client.id)
                  },
                },
                h(
                  'span',
                  { className: 'ml-nav-pill-left' },
                  h(HostLogo, { kind: client.kind, size: 15 }),
                  h('span', { className: 'ml-nav-label' }, client.name),
                ),
                h(
                  'span',
                  { className: 'ml-nav-pill-right' },
                  isClientUnhealthy(client)
                    ? h(
                        'span',
                        {
                          style: { color: 'var(--ml-danger)', display: 'inline-flex' },
                          title: t(`desktop.status.${client.health}`),
                        },
                        Icons.shield(),
                      )
                    : !client.writable
                      ? h(
                          'span',
                          {
                            style: { color: 'var(--ml-warn)', display: 'inline-flex' },
                            title: t('desktop.status.readonly'),
                          },
                          Icons.lock(),
                        )
                      : null,
                  count !== undefined
                    ? h('span', { className: 'ml-nav-count' }, String(count))
                    : null,
                ),
              )
            }),
          ),

          // Maintenance & Host Settings
          h(
            'div',
            { className: 'memloom-rail-section' },
            h(
              'div',
              { className: 'memloom-rail-heading-row' },
              h('span', { className: 'memloom-rail-heading' }, t('desktop.sidebar.maintenance')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ml-nav-pill',
                ...(route === 'audit' ? { 'aria-current': 'page' } : {}),
                onClick: () => setRoute('audit'),
              },
              h(
                'span',
                { className: 'ml-nav-pill-left' },
                h(
                  'span',
                  {
                    style: {
                      color: route === 'audit' ? 'var(--ml-copper)' : 'var(--ml-text-muted)',
                      display: 'inline-flex',
                    },
                  },
                  Icons.history(),
                ),
                h('span', { className: 'ml-nav-label' }, t('desktop.nav.audit')),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ml-nav-pill',
                ...(route === 'config' ? { 'aria-current': 'page' } : {}),
                onClick: () => setRoute('config'),
              },
              h(
                'span',
                { className: 'ml-nav-pill-left' },
                h(
                  'span',
                  {
                    style: {
                      color: route === 'config' ? 'var(--ml-copper)' : 'var(--ml-text-muted)',
                      display: 'inline-flex',
                    },
                  },
                  Icons.sliders(),
                ),
                h('span', { className: 'ml-nav-label' }, t('desktop.nav.config')),
              ),
            ),
          ),
        ),
      ),

      // Footer: Command Palette + Locale + Light/Dark Segmented Switch
      h(
        'div',
        { className: 'memloom-rail-footer' },
        h(
          'div',
          { className: 'memloom-rail-prefs-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'ml-btn',
              'data-variant': 'surface',
              style: { flex: '1 1 auto', justifyContent: 'space-between', padding: '0 10px' },
              onClick: () => setCmdOpen(true),
            },
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '7px',
                  color: 'var(--ml-text-secondary)',
                },
              },
              Icons.search(),
              h('span', null, t('desktop.sidebar.commandPalette')),
            ),
            h('span', { className: 'ml-kbd' }, 'Ctrl K'),
          ),
          h(
            Button,
            {
              variant: 'surface',
              onClick: () => {
                void toggleLocale()
              },
            },
            t('desktop.langToggle'),
          ),
        ),
        h(SegmentedControl<'light' | 'dark'>, {
          label: t('desktop.themeLight'),
          fullWidth: true,
          value: resolvedTheme,
          onChange: (next) => {
            void setTheme(next)
          },
          items: [
            {
              id: 'light',
              label: h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
                Icons.sun(),
                h('span', null, t('desktop.themeLight')),
              ),
            },
            {
              id: 'dark',
              label: h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
                Icons.moon(),
                h('span', null, t('desktop.themeDark')),
              ),
            },
          ],
        }),
      ),
    ),

    // Floating Stage
    h(
      'main',
      { className: 'memloom-stage' },
      loading
        ? h(EmptyBlock, { title: t('state.loading') })
        : loadError !== ''
          ? h(EmptyBlock, {
              icon: Icons.shield(),
              title: t('state.error'),
              description: loadError,
              action: h(Button, { onClick: () => void loadAll() }, t('common.retry')),
            })
          : route === 'memories'
            ? h(MemoriesView, {
                bridge,
                clients,
                activeHostId,
                onSelectHost: (id, focusRecordId) => {
                  setActiveHostId(id)
                  if (focusRecordId !== undefined && id !== 'all') {
                    const seq = ++openMemorySeq.current
                    setOpenMemoryReq({ clientId: id, id: focusRecordId, seq })
                  }
                },
                refreshToken,
                banners: bannersNode,
                ...(openMemoryReq !== undefined ? { openMemoryRequest: openMemoryReq } : {}),
                onDataChanged: syncAfterDataChange,
                onExternalChange: () => setExternalChanged(true),
                onOpenMigration: (sourceId, selection) => {
                  setMigrateReq({
                    sourceClientId: sourceId,
                    ...(selection !== undefined ? { selection } : {}),
                  })
                  setRoute('migrate')
                },
                onNotify: notify,
              })
            : route === 'review'
              ? h(ReviewView, {
                  bridge,
                  clients,
                  refreshToken,
                  banners: bannersNode,
                  onDataChanged: syncAfterDataChange,
                  onExternalChange: () => setExternalChanged(true),
                  onPendingCountChange: setPendingTotal,
                  onOpenMemories: () => setRoute('memories'),
                  onNotify: notify,
                })
              : route === 'migrate'
                ? h(MigrationView, {
                    bridge,
                    clients,
                    ...(migrateReq.sourceClientId !== undefined
                      ? { initialSourceClientId: migrateReq.sourceClientId }
                      : {}),
                    ...(migrateReq.selection !== undefined
                      ? { initialSelection: migrateReq.selection }
                      : {}),
                    banners: bannersNode,
                    onSuccess: syncAfterDataChange,
                    onExternalChange: () => setExternalChanged(true),
                    onOpenTargetHost: (clientId) => {
                      setRoute('memories')
                      setActiveHostId(clientId)
                    },
                    onClearSelection: () => setMigrateReq({}),
                    onNotify: notify,
                  })
                : route === 'audit'
                  ? h(DreamAuditPanel, {
                      bridge,
                      clients,
                      refreshToken,
                      banners: bannersNode,
                      onDataChanged: syncAfterDataChange,
                      onExternalChange: () => setExternalChanged(true),
                      onNotify: notify,
                    })
                  : h(DesktopConfigPanel, {
                      bridge,
                      clients,
                      ...(guardSnapshot !== undefined ? { guardSnapshot } : {}),
                      refreshToken,
                      banners: bannersNode,
                      onRecheckGuard: recheckGuard,
                      onRequestUnlockDsh: () => setUnlockModalOpen(true),
                      onRelockDsh: relockGuard,
                      onDataChanged: syncAfterDataChange,
                      onExternalChange: () => setExternalChanged(true),
                      onNotify: notify,
                    }),
    ),

    // Command Palette Modal
    cmdOpen
      ? h(CommandPalette, {
          clients,
          resolvedTheme,
          onClose: () => setCmdOpen(false),
          onNavigate: (nextRoute, hostId) => {
            setRoute(nextRoute)
            if (hostId !== undefined) setActiveHostId(hostId)
            setCmdOpen(false)
          },
          onToggleTheme: () => {
            void setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
            setCmdOpen(false)
          },
          onToggleLocale: () => {
            void toggleLocale()
            setCmdOpen(false)
          },
        })
      : null,

    // DSH Force-Unlock Confirmation Modal
    unlockModalOpen
      ? h(
          Modal,
          {
            title: t('desktop.guard.unlockTitle'),
            closeLabel: t('common.close'),
            maxWidth: 460,
            onClose: () => setUnlockModalOpen(false),
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { disabled: guardBusy, onClick: () => setUnlockModalOpen(false) },
                t('common.cancel'),
              ),
              h(
                Button,
                {
                  variant: 'danger',
                  disabled: guardBusy,
                  onClick: () => void confirmForceUnlock(),
                },
                t('desktop.guard.unlockConfirm'),
              ),
            ),
          },
          h(
            'p',
            {
              role: 'alert',
              style: {
                margin: 0,
                fontSize: '13px',
                color: 'var(--ml-text-secondary)',
                lineHeight: 1.6,
              },
            },
            t('desktop.guard.unlockWarning'),
          ),
        )
      : null,

    h(ToastHost, { toasts }),
  )
}

/* ------------------------------------------------------------------ *
 * Ctrl + K Command Palette
 * ------------------------------------------------------------------ */

function CommandPalette(props: {
  readonly clients: readonly DesktopClientInfo[]
  readonly resolvedTheme: 'light' | 'dark'
  readonly onClose: () => void
  readonly onNavigate: (route: AppRoute, hostId?: string | 'all') => void
  readonly onToggleTheme: () => void
  readonly onToggleLocale: () => void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const allItems = React.useMemo(() => {
    const base: Array<{
      readonly id: string
      readonly group: string
      readonly label: string
      readonly hint: string
      readonly icon?: React.ReactNode
      readonly run: () => void
    }> = [
      {
        id: 'nav-memories',
        group: t('desktop.cmd.groupNav'),
        label: t('desktop.nav.memories'),
        hint: 'memories',
        run: () => props.onNavigate('memories', 'all'),
      },
      {
        id: 'nav-review',
        group: t('desktop.cmd.groupNav'),
        label: t('desktop.nav.review'),
        hint: 'review',
        run: () => props.onNavigate('review'),
      },
      {
        id: 'nav-migrate',
        group: t('desktop.cmd.groupNav'),
        label: t('desktop.nav.migrate'),
        hint: 'migrate',
        run: () => props.onNavigate('migrate'),
      },
      {
        id: 'nav-audit',
        group: t('desktop.cmd.groupNav'),
        label: t('desktop.nav.audit'),
        hint: 'audit',
        run: () => props.onNavigate('audit'),
      },
      {
        id: 'nav-config',
        group: t('desktop.cmd.groupNav'),
        label: t('desktop.nav.config'),
        hint: 'config',
        run: () => props.onNavigate('config'),
      },
      ...props.clients.map((c) => ({
        id: `host-${c.id}`,
        group: t('desktop.cmd.groupHost'),
        label: c.name,
        hint: c.format ?? c.kind,
        icon: h(HostLogo, { kind: c.kind, size: 14 }),
        run: () => props.onNavigate('memories', c.id),
      })),
      {
        id: 'pref-theme',
        group: t('desktop.cmd.groupTheme'),
        label: t('desktop.cmd.toggleTheme'),
        hint: props.resolvedTheme,
        run: props.onToggleTheme,
      },
      {
        id: 'pref-lang',
        group: t('desktop.cmd.groupTheme'),
        label: t('desktop.cmd.toggleLang'),
        hint: 'zh / en',
        run: props.onToggleLocale,
      },
    ]
    const q = query.trim().toLowerCase()
    if (q === '') return base
    return base.filter((it) => `${it.group} ${it.label} ${it.hint}`.toLowerCase().includes(q))
  }, [props, query])

  const clampedCursor = Math.min(cursor, Math.max(0, allItems.length - 1))

  return h(
    'div',
    {
      className: 'ml-backdrop',
      'data-align': 'top',
      onClick: (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) props.onClose()
      },
    },
    h(
      'div',
      {
        className: 'ml-cmd-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('desktop.sidebar.commandPalette'),
      },
      h(
        'div',
        {
          style: {
            height: '48px',
            padding: '0 16px',
            borderBottom: '1px solid var(--ml-border)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          },
        },
        h(
          'span',
          { style: { color: 'var(--ml-text-muted)', display: 'inline-flex' } },
          Icons.search(),
        ),
        h('input', {
          ref: inputRef,
          type: 'text',
          className: 'ml-search-input',
          placeholder: t('desktop.cmd.placeholder'),
          value: query,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setQuery(e.target.value)
            setCursor(0)
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              props.onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(allItems.length - 1, c + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            } else if (e.key === 'Enter' && allItems[clampedCursor] !== undefined) {
              e.preventDefault()
              allItems[clampedCursor]!.run()
            }
          },
        }),
        h('span', { className: 'ml-kbd' }, 'Esc'),
      ),
      h(
        'div',
        {
          className: 'ml-scroll',
          style: { maxHeight: '320px', overflowY: 'auto', padding: '8px' },
        },
        allItems.length === 0
          ? h(
              'div',
              {
                style: {
                  padding: '24px',
                  textAlign: 'center',
                  fontSize: '12px',
                  color: 'var(--ml-text-muted)',
                },
              },
              t('desktop.cmd.empty'),
            )
          : allItems.map((item, idx) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  onClick: item.run,
                  style: {
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    border: 0,
                    background: idx === clampedCursor ? 'var(--ml-recessed)' : 'transparent',
                    color: 'var(--ml-text-primary)',
                    font: 'inherit',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    textAlign: 'left',
                  },
                },
                h(
                  'span',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '10px' } },
                  h(
                    'span',
                    { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                    item.group,
                  ),
                  item.icon ?? null,
                  h(
                    'span',
                    { style: { fontWeight: idx === clampedCursor ? 500 : 400 } },
                    item.label,
                  ),
                ),
                h(
                  'span',
                  {
                    className: 'ml-mono',
                    style: { fontSize: '12px', color: 'var(--ml-text-muted)' },
                  },
                  item.hint,
                ),
              ),
            ),
      ),
    ),
  )
}
