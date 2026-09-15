import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import './index.css'
import './i18n'

import { AppearanceProvider } from './components/appearance-provider'
import { RuntimeProvider } from './contexts/runtime-context'
import { SidebarConfigProvider } from './contexts/sidebar-config-context'
import { clearDBXResourceDiscovery } from './lib/dbx-resource-discovery'
import { QueryProvider } from './lib/query-provider'
import { router } from './routes'

export function AppBootstrap() { return <RouterProvider router={router} /> }
function DBXRoot() {
  const [connection, setConnection] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const bridge = (window as unknown as {dbxPlugin?: {ready: Promise<void>; context?: {connectionId?: string}; onContext?: (fn: (context: {connectionId?: string}) => void) => () => void}}).dbxPlugin
    if (!bridge) {setError('DBX Host Bridge unavailable'); return}
    let alive = true
    const update = () => { if (alive) {clearDBXResourceDiscovery(); setConnection(bridge.context?.connectionId || null)} }
    const off = bridge.onContext?.(update)
    window.addEventListener('dbx-plugin-env', update)
    bridge.ready.then(update).catch(reason => {if (alive) setError(String(reason))})
    return () => {alive = false; off?.(); window.removeEventListener('dbx-plugin-env', update)}
  }, [])
  if (error) return <div role="alert" className="p-6">{error}</div>
  if (!connection) return <div className="p-6 text-muted-foreground">等待 DBX 连接…</div>
  return <QueryProvider key={connection}>
    <AppearanceProvider defaultTheme="system" defaultColorTheme="default" defaultFont="maple">
      <RuntimeProvider><SidebarConfigProvider><AppBootstrap /></SidebarConfigProvider></RuntimeProvider>
    </AppearanceProvider>
  </QueryProvider>
}
createRoot(document.getElementById('root')!).render(<StrictMode><DBXRoot /></StrictMode>)
