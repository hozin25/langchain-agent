import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      setTheme: theme => set({ theme }),
      toggle: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' })
    }),
    {
      name: 'theme-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({ theme: state.theme })
    }
  )
)
