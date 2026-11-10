import { QueryClient } from '@tanstack/react-query'

// The management session owns this cache. Logout/expiry clears it with the
// token; no user data or query results are persisted to browser storage.
export const managementQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0, refetchIntervalInBackground: true },
  },
})

export const managementKeys = {
  health: ['management', 'health'] as const,
  components: ['management', 'components'] as const,
  apps: ['management', 'apps'] as const,
  app: (id: string | undefined) => ['management', 'app', id ?? null] as const,
  candidates: (id: string | undefined) => ['management', 'candidates', id ?? null] as const,
  overview: ['management', 'stream-session-overview'] as const,
  logs: (page: number, targetType: string) => ['management', 'logs', page, targetType] as const,
}
