import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { novelService, volumeService, chapterService } from '@/services/data-service'
import { useNovelStore } from '@/stores'
import type { Novel, Volume, Chapter } from '@shared/types'

// ===== Novel Hooks =====
export function useNovels() {
  const setNovels = useNovelStore((s) => s.setNovels)
  const setLoading = useNovelStore((s) => s.setLoading)

  return useQuery({
    queryKey: ['novels'],
    queryFn: async () => {
      setLoading(true)
      const novels = await novelService.getAll()
      setNovels(novels)
      setLoading(false)
      return novels
    },
    staleTime: 10_000,
  })
}

export function useNovel(id: string) {
  return useQuery({
    queryKey: ['novels', id],
    queryFn: () => novelService.getById(id),
    enabled: !!id,
  })
}

export function useCreateNovel() {
  const queryClient = useQueryClient()
  const addNovel = useNovelStore((s) => s.addNovel)

  return useMutation({
    mutationFn: async (novel: Novel) => {
      await novelService.create(novel)
      addNovel(novel)
      return novel
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['novels'] })
    },
  })
}

export function useDeleteNovel() {
  const queryClient = useQueryClient()
  const removeNovel = useNovelStore((s) => s.removeNovel)

  return useMutation({
    mutationFn: async (id: string) => {
      await novelService.delete(id)
      removeNovel(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['novels'] })
    },
  })
}

export function useUpdateNovel() {
  const queryClient = useQueryClient()
  const updateLocal = useNovelStore((s) => s.updateNovel)

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Novel> }) => {
      await novelService.update(id, data)
      return { id, data }
    },
    onSuccess: ({ id, data }) => {
      updateLocal(id, data)
      queryClient.invalidateQueries({ queryKey: ['novels'] })
    },
  })
}

// ===== Volume Hooks =====
export function useVolumes(novelId: string) {
  return useQuery({
    queryKey: ['volumes', novelId],
    queryFn: () => volumeService.getByNovelId(novelId),
    enabled: !!novelId,
  })
}

// ===== Chapter Hooks =====
export function useChapters(volumeId: string | null) {
  return useQuery({
    queryKey: ['chapters', volumeId],
    queryFn: () => chapterService.getByVolumeId(volumeId!),
    enabled: !!volumeId,
  })
}

export function useChapterContent(chapterId: string | null) {
  return useQuery({
    queryKey: ['chapter-content', chapterId],
    queryFn: () => chapterService.loadContent(chapterId!),
    enabled: !!chapterId,
  })
}
