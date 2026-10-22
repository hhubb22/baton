import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { BatonClient } from './client'
import type { ID } from './types'

// 查询键的第一段是数据主题，收到某个主题的变化时刷新以它开头的全部查询。
export const keys = {
  session: ['session'] as const,
  devices: ['devices'] as const,
  projects: ['projects'] as const,
  threads: ['threads'] as const,
  messages: (threadId: ID) => ['messages', threadId] as const,
  inbox: ['inbox'] as const,
  file: (deviceId: ID, path: string) => ['files', deviceId, path] as const,
  operation: (id: ID) => ['operations', id] as const,
}

const ClientContext = createContext<BatonClient | null>(null)

export function useClient() {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useClient must be used inside ClientProvider')
  return client
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  })
}

export function ClientProvider({ client, children }: { client: BatonClient; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  useEffect(
    () =>
      client.subscribe(({ topics }) => {
        for (const topic of topics) void queryClient.invalidateQueries({ queryKey: [topic] })
      }),
    [client, queryClient],
  )

  return (
    <ClientContext value={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ClientContext>
  )
}

export function useSession() {
  const client = useClient()
  return useQuery({ queryKey: keys.session, queryFn: () => client.getSession() })
}

export function useDevices() {
  const client = useClient()
  return useQuery({ queryKey: keys.devices, queryFn: () => client.listDevices() })
}

export function useProjects() {
  const client = useClient()
  return useQuery({ queryKey: keys.projects, queryFn: () => client.listProjects() })
}

export function useThreads() {
  const client = useClient()
  return useQuery({ queryKey: keys.threads, queryFn: () => client.listThreads() })
}

export function useMessages(threadId: ID) {
  const client = useClient()
  return useQuery({ queryKey: keys.messages(threadId), queryFn: () => client.listMessages(threadId) })
}

export function useInbox() {
  const client = useClient()
  return useQuery({ queryKey: keys.inbox, queryFn: () => client.listInbox() })
}

// 文件内容随设备状态刷新：设备变化会发出 files 主题，旧预览不保留。
export function useFile(deviceId: ID, path: string) {
  const client = useClient()
  return useQuery({ queryKey: keys.file(deviceId, path), queryFn: () => client.readFile(deviceId, path), gcTime: 0 })
}

export function useOperation(id: ID | null) {
  const client = useClient()
  return useQuery({
    queryKey: keys.operation(id ?? ''),
    queryFn: () => client.getOperation(id!),
    enabled: id !== null,
  })
}

export function useSignIn() {
  const client = useClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) => client.signIn(username, password),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.session, session)
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'session' })
    },
  })
}

export function useSignOut() {
  const client = useClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => client.signOut(),
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' })
    },
  })
}

let clientSequence = 0

// 同一次发送重试时沿用 clientId，避免重复消息。
export function newClientId() {
  clientSequence += 1
  return `web-${Date.now().toString(36)}-${clientSequence}`
}

export function useSendMessage() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { threadId: ID; body: string; clientId: string }) => client.sendMessage(input),
  })
}

export function useStopThread() {
  const client = useClient()
  return useMutation({ mutationFn: (threadId: ID) => client.stopThread(threadId) })
}

export function useAnswerItem() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { itemId: ID; answer: string; revision: number }) => client.answerItem(input),
  })
}
