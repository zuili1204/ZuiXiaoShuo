import { create } from 'zustand'
import type { Novel } from '@shared/types'

interface NovelStore {
  novels: Novel[]
  currentNovel: Novel | null
  isLoading: boolean
  setNovels: (novels: Novel[]) => void
  addNovel: (novel: Novel) => void
  updateNovel: (id: string, data: Partial<Novel>) => void
  removeNovel: (id: string) => void
  setCurrentNovel: (novel: Novel | null) => void
  setLoading: (loading: boolean) => void
}

export const useNovelStore = create<NovelStore>((set) => ({
  novels: [],
  currentNovel: null,
  isLoading: false,

  setNovels: (novels) => set({ novels }),

  addNovel: (novel) =>
    set((state) => ({ novels: [novel, ...state.novels] })),

  updateNovel: (id, data) =>
    set((state) => ({
      novels: state.novels.map((n) => (n.id === id ? { ...n, ...data } : n)),
      currentNovel: state.currentNovel?.id === id
        ? { ...state.currentNovel, ...data }
        : state.currentNovel,
    })),

  removeNovel: (id) =>
    set((state) => ({
      novels: state.novels.filter((n) => n.id !== id),
      currentNovel: state.currentNovel?.id === id ? null : state.currentNovel,
    })),

  setCurrentNovel: (novel) => set({ currentNovel: novel }),
  setLoading: (isLoading) => set({ isLoading }),
}))
