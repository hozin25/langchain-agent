import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { useChatStore } from './stores/chat'
import { useThemeStore } from './stores/theme'

export default function App() {
  const setModels = useChatStore(s => s.setModels)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const hydrateSettings = useChatStore(s => s.hydrateSettings)
  const theme = useThemeStore(s => s.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    void window.api.agent.listModels().then(({ models, defaultId }) => {
      setModels(models, defaultId)
    })
  }, [setModels])

  // Reopen into the last-used workspace so its history is immediately visible.
  useEffect(() => {
    void window.api.app.getLastWorkspace().then(last => {
      if (last) void setWorkspace(last)
    })
  }, [setWorkspace])

  // Restore the persisted operating mode (and bypass acknowledgment) so the app
  // reopens into whatever mode the user last chose (bypass stays bypass without
  // re-warning, since the acknowledgment is already recorded).
  useEffect(() => {
    void hydrateSettings()
  }, [hydrateSettings])

  return (
    <div className="app">
      <Sidebar />
      <main className="app__main">
        <ChatPanel />
      </main>
      <SettingsPanel />
    </div>
  )
}
