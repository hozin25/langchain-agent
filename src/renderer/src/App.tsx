import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="app__main">
        <ChatPanel />
      </main>
    </div>
  )
}
