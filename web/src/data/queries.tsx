import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ClientError, type BatonClient } from './client'
import type {
  AgentKind,
  ID,
  ItemDecision,
  Project,
  ProjectPatch,
  Reference,
  SaveMemoryInput,
  SendMode,
  Session,
  ThreadAnswerInput,
} from './types'

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
  thread: (id: ID) => ['threads', 'detail', id] as const,
  messages: (threadId: ID) => ['messages', threadId] as const,
  inbox: ['inbox'] as const,
  file: (deviceId: ID, path: string) => ['files', deviceId, path] as const,
  // 过程保存在中心，随消息更新，与设备连接状态无关。
  trace: (messageId: ID) => ['messages', 'trace', messageId] as const,
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

export function useDeviceFolders(deviceId: ID, connected: boolean) {
  const client = useClient()
  return useQuery({
    queryKey: ['devices', 'allowedFolders', deviceId],
    queryFn: () => client.listDeviceFolders(deviceId),
    enabled: connected,
    refetchOnMount: 'always',
  })
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
  return useQuery({
    queryKey: keys.projectMemory(projectId),
    queryFn: () => client.listProjectMemory(projectId),
    refetchOnMount: false,
    retryOnMount: false,
  })
}

export function useThreads() {
  const client = useClient()
  return useQuery({ queryKey: keys.threads, queryFn: () => client.listThreads() })
}

export function useThread(threadId: ID) {
  const client = useClient()
  return useQuery({ queryKey: keys.thread(threadId), queryFn: () => client.getThread(threadId) })
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
  return useInfiniteQuery({
    queryKey: keys.trace(messageId),
    queryFn: ({ pageParam }) => client.readTrace(messageId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.state === 'ready' ? page.nextCursor : undefined),
    enabled,
  })
}

export function useLiveOutput(threadId: ID, enabled: boolean) {
  const client = useClient()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled || !client.subscribeOutput) return
    return client.subscribeOutput(threadId, (output) => {
      if (output) queryClient.setQueryData(keys.output(threadId), output)
      else void queryClient.invalidateQueries({ queryKey: keys.output(threadId), exact: true })
    })
  }, [client, queryClient, threadId, enabled])
  return useQuery({ queryKey: keys.output(threadId), queryFn: () => client.readOutput(threadId), enabled, gcTime: 0 })
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
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' })
      queryClient.setQueryData(keys.session, session)
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

// 同一次发送重试时沿用 clientId，避免重复消息。
export function newClientId() {
  return crypto.randomUUID()
}

export function useCreateThread() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: {
      deviceId: ID
      folder: string
      agent: AgentKind
      model: string
      executionTimeoutSeconds?: number
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

export function useSetThreadExecutionLimit() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { threadId: ID; executionTimeoutSeconds: number }) => client.setThreadExecutionLimit(input),
  })
}

export function useSetThreadModel() {
  const client = useClient()
  return useMutation({ mutationFn: (input: { threadId: ID; model: string }) => client.setThreadModel(input) })
}

export function useAnswerThreadQuestion() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { threadId: ID; answer: ThreadAnswerInput }) => client.answerThreadQuestion(input),
  })
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

export function useUpdateProject(projectId: ID) {
  const client = useClient()
  const cache = useQueryClient()
  return useMutation({
    scope: { id: `project-settings:${projectId}` },
    mutationFn: (input: { projectId: ID; patch: ProjectPatch }) => client.updateProject(input),
    onSuccess: (project, { patch }) =>
      cache.setQueryData<Project[]>(keys.projects, (items) =>
        items?.map((item) =>
          item.id === project.id
            ? {
                ...item,
                name: patch.name === undefined ? item.name : project.name,
                goal: patch.goal === undefined ? item.goal : project.goal,
                subscription: patch.subscription === undefined ? item.subscription : project.subscription,
                model: patch.model === undefined ? item.model : project.model,
              }
            : item,
        ),
      ),
  })
}

export function useSetProjectStatus() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { projectId: ID; status: 'active' | 'paused' | 'archived' }) => client.setProjectStatus(input),
  })
}

export function useSaveMemory() {
  const client = useClient()
  return useMutation({ mutationFn: (input: SaveMemoryInput) => client.saveMemory(input) })
}

export function useChangeMemory() {
  const client = useClient()
  return useMutation({ mutationFn: (input: import('./types').ChangeMemoryInput) => client.changeMemory(input) })
}
export function useMemorySources(projectId: ID, note: import('./types').MemoryNote | null, enabled: boolean) {
  const client = useClient()
  return useQuery({
    queryKey: ['memory-sources', projectId, note?.id, note?.version],
    queryFn: () => client.memorySources(projectId, note!),
    enabled: enabled && note !== null,
  })
}

export function useStopProjectRun() {
  const client = useClient()
  return useMutation({ mutationFn: (projectId: ID) => client.stopProjectRun(projectId) })
}

export function useHandleItem() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { itemId: ID; decision: ItemDecision; revision: number }) => client.handleItem(input),
  })
}

export function useRetryProject() {
  const client = useClient()
  return useMutation({ mutationFn: (projectId: ID) => client.retryProject(projectId) })
}

export function useSetDefaultDevice() {
  const client = useClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deviceId: ID) => client.setDefaultDevice(deviceId),
    onSuccess: (session) => queryClient.setQueryData(keys.session, session),
  })
}

export function useAddDeviceFolder() {
  const client = useClient()
  return useMutation({ mutationFn: (input: { deviceId: ID; path: string }) => client.addDeviceFolder(input) })
}

export function useRemoveDeviceFolder() {
  const client = useClient()
  return useMutation({ mutationFn: (input: { deviceId: ID; path: string }) => client.removeDeviceFolder(input) })
}

export function useStartSubscriptionLogin() {
  const client = useClient()
  return useMutation({
    mutationFn: (input: { deviceId: ID; provider: string }) => client.startSubscriptionLogin(input),
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
