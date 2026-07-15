import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { useChatStore } from './stores/chat'

export default function App() {
  const setModels = useChatStore(s => s.setModels)

  useEffect(() => {
    void window.api.agent.listModels().then(({ models, defaultId }) => {
      setModels(models, defaultId)
    })
  }, [setModels])

  return (
    <div className="app">
      <Sidebar />
      <main className="app__main">
        <ChatPanel />
      </main>
    </div>
  )
}
