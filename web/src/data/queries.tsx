import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ClientError, type BatonClient } from './client'
import type { AgentKind, HistoryPage, ID, Message, Reference, SendMode, Session } from './types'

// 查询键的第一段是数据主题，收到某个主题的变化时刷新以它开头的全部查询。
export const keys = {
  session: ['session'] as const,
  devices: ['devices'] as const,
  // 设置码状态随设备接入变化，所以放在 devices 主题下。
  enrollment: (id: ID) => ['devices', 'enrollment', id] as const,
  // 目录列表随设备连接状态变化。
  folders: (deviceId: ID, path: string | null) => ['devices', 'folders', deviceId, path] as const,
  projects: ['projects'] as const,
  projectEntries: (id: ID) => ['projects', 'entries', id] as const,
  projectMemory: (id: ID) => ['projects', 'memory', id] as const,
  threads: ['threads'] as const,
  messages: (threadId: ID) => ['messages', threadId] as const,
  inbox: ['inbox'] as const,
  file: (deviceId: ID, path: string) => ['files', deviceId, path] as const,
  // 过程从设备读取，设备连接变化时重读，离线后不留旧内容。
  trace: (messageId: ID) => ['devices', 'trace', messageId] as const,
  output: (threadId: ID) => ['messages', 'output', threadId] as const,
  operation: (id: ID) => ['operations', id] as const,
}

const ClientContext = createContext<BatonClient | null>(null)

export function useClient() {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useClient must be used inside ClientProvider')
  return client
}

// 任何请求被拒绝为未登录，都说明会话已在中心结束，重新读取会话让工作区回到登录页。
export function createQueryClient() {
  const onError = (error: Error) => {
    if (error instanceof ClientError && error.code === 'unauthorized') {
      void queryClient.invalidateQueries({ queryKey: keys.session })
    }
  }
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  })
  return queryClient
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

export function useEnrollment(id: ID | null) {
  const client = useClient()
  return useQuery({
    queryKey: keys.enrollment(id ?? ''),
    queryFn: () => client.getEnrollment(id!),
    enabled: id !== null,
  })
}

export function useProjects() {
  const client = useClient()
  return useQuery({ queryKey: keys.projects, queryFn: () => client.listProjects() })
}

export function useProjectEntries(projectId: ID) {
  const client = useClient()
  return useQuery({ queryKey: keys.projectEntries(projectId), queryFn: () => client.listProjectEntries(projectId) })
}

export function useProjectMemory(projectId: ID) {
  const client = useClient()
  return useQuery({ queryKey: keys.projectMemory(projectId), queryFn: () => client.listProjectMemory(projectId) })
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
export function useFile(deviceId: ID, path: string | null) {
  const client = useClient()
  return useQuery({
    queryKey: keys.file(deviceId, path ?? ''),
    queryFn: () => client.readFile(deviceId, path!),
    enabled: path !== null,
    gcTime: 0,
  })
}

export function useTrace(messageId: ID, enabled: boolean) {
  const client = useClient()
  return useQuery({ queryKey: keys.trace(messageId), queryFn: () => client.readTrace(messageId), enabled, gcTime: 0 })
}

export function useLiveOutput(threadId: ID, enabled: boolean) {
  const client = useClient()
  return useQuery({ queryKey: keys.output(threadId), queryFn: () => client.readOutput(threadId), enabled })
}

export interface EarlierHistory {
  // 已读到的更早消息，按时间排列。
  messages: Message[]
  // idle：还没读或可以继续读；done：已经读到开头。
  status: 'idle' | 'loading' | 'failed' | 'unavailable' | 'done'
  reason: Extract<HistoryPage, { state: 'unavailable' }>['reason'] | null
  load: () => void
}

// 更早的对话按需一页页读取。已读到的页留在页面里，之后某页读不到也不影响已显示的消息。
export function useEarlierHistory(threadId: ID): EarlierHistory {
  const client = useClient()
  const [state, setState] = useState<Omit<EarlierHistory, 'load'> & { threadId: ID }>({
    threadId,
    messages: [],
    status: 'idle',
    reason: null,
  })
  const current =
    state.threadId === threadId ? state : { threadId, messages: [], status: 'idle' as const, reason: null }
  const latest = useRef(current)
  useEffect(() => {
    latest.current = current
  })

  const load = useCallback(() => {
    const before = latest.current
    if (before.status === 'loading' || before.status === 'done') return
    setState({ ...before, status: 'loading', reason: null })
    client.readHistory(threadId, before.messages[0]?.id ?? null).then(
      (page) =>
        setState((now) => {
          if (now.threadId !== threadId) return now
          if (page.state === 'unavailable') return { ...now, status: 'unavailable', reason: page.reason }
          return { ...now, messages: [...page.messages, ...now.messages], status: page.more ? 'idle' : 'done' }
        }),
      () => setState((now) => (now.threadId === threadId ? { ...now, status: 'failed' } : now)),
    )
  }, [client, threadId])

  return { messages: current.messages, status: current.status, reason: current.reason, load }
}

export function useFolders(deviceId: ID | null, path: string | null) {
  const client = useClient()
  return useQuery({
    queryKey: keys.folders(deviceId ?? '', path),
    queryFn: () => client.listFolders(deviceId!, path),
    enabled: deviceId !== null,
  })
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
      queryClient.setQueryData<Session>(keys.session, { account: null, defaultDeviceId: null, ended: null })
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

export function useCreateThread() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: {
      deviceId: ID
      folder: string
      agent: AgentKind
      model: string
      body: string
      clientId: string
    }) => client.createThread(input),
  })
}

export function useSendMessage() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { threadId: ID; body: string; clientId: string; mode?: SendMode }) => client.sendMessage(input),
  })
}

export function useCancelMessage() {
  const client = useClient()
  return useMutation({ mutationFn: (messageId: ID) => client.cancelMessage(messageId) })
}

export function useSetThreadModel() {
  const client = useClient()
  return useMutation({ mutationFn: (input: { threadId: ID; model: string }) => client.setThreadModel(input) })
}

export function useStopThread() {
  const client = useClient()
  return useMutation({ mutationFn: (threadId: ID) => client.stopThread(threadId) })
}

export function useArchiveThread() {
  const client = useClient()
  return useMutation({ mutationFn: (threadId: ID) => client.archiveThread(threadId) })
}

export function useResumeThread() {
  const client = useClient()
  return useMutation({ mutationFn: (threadId: ID) => client.resumeThread(threadId) })
}

export function useCreateProject() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { name: string; goal: string; subscription: string; model: string; clientId: string }) =>
      client.createProject(input),
  })
}

export function useSendProjectMessage() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { projectId: ID; body: string; clientId: string; reference?: Reference | null }) =>
      client.sendProjectMessage(input),
  })
}

export function useStopProjectRun() {
  const client = useClient()
  return useMutation({ mutationFn: (projectId: ID) => client.stopProjectRun(projectId) })
}

export function useAnswerItem() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { itemId: ID; answer: string; revision: number }) => client.answerItem(input),
  })
}

export function useSetDefaultDevice() {
  const client = useClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deviceId: ID) => client.setDefaultDevice(deviceId),
    onSuccess: (session) => queryClient.setQueryData(keys.session, session),
  })
}

export function useSetCommandAccess() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { deviceId: ID; enabled: boolean }) => client.setCommandAccess(input),
  })
}

export function useRemoveDevice() {
  const client = useClient()
  return useMutation({ mutationFn: (deviceId: ID) => client.removeDevice(deviceId) })
}

export function useCreateEnrollment() {
  const client = useClient()
  return useMutation({ mutationFn: () => client.createEnrollment() })
}
