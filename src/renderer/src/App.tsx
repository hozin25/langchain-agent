import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { useChatStore } from './stores/chat'

export default function App() {
  const setModels = useChatStore(s => s.setModels)
  const setWorkspace = useChatStore(s => s.setWorkspace)

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

  return (
    <div className="app">
      <Sidebar />
      <main className="app__main">
        <ChatPanel />
      </main>
    </div>
  )
}
