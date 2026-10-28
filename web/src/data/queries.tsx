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
import { ClientError, type BatonClient, type ChangeEvent } from './client'
import type {
  AgentKind,
  ID,
  ItemDecision,
  InboxItem,
  Message,
  Operation,
  Project,
  ProjectPatch,
  Reference,
  SaveMemoryInput,
  SendMode,
  Session,
  ThreadAnswerInput,
  Thread,
} from './types'

// 查询键的第一段是数据主题；按需设备读取只在用户操作时刷新。
export const keys = {
  session: ['session'] as const,
  downloads: ['downloads'] as const,
  devices: ['devices'] as const,
  // 设置码状态随设备接入变化，所以放在 devices 主题下。
  enrollment: (id: ID) => ['devices', 'enrollment', id] as const,
  // 文件和目录内容由设备按需返回。
  folders: (deviceId: ID, path: string | null) => ['devices', 'folders', deviceId, path] as const,
  projects: ['projects'] as const,
  project: (id: ID) => ['projects', 'detail', id] as const,
  projectEntries: (id: ID) => ['projects', 'entries', id] as const,
  projectMemory: (id: ID) => ['projects', 'memory', id] as const,
  memoryStatus: (id: ID) => ['projects', 'memoryStatus', id] as const,
  memorySources: (projectId: ID, noteId?: ID, version?: number) =>
    ['projects', 'memorySources', projectId, noteId, version] as const,
  threads: ['threads'] as const,
  thread: (id: ID) => ['threads', 'detail', id] as const,
  messages: (threadId: ID) => ['messages', threadId] as const,
  inbox: ['inbox'] as const,
  activity: ['activity'] as const,
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

function refreshListItem<T extends { id: ID }>(
  queryClient: QueryClient,
  listKey: readonly string[],
  detailKey: readonly string[],
  id: ID,
  queryFn: () => Promise<T>,
) {
  if (!queryClient.getQueryData<T[]>(listKey)) return
  void queryClient
    .fetchQuery({ queryKey: detailKey, queryFn })
    .then((entity) => {
      queryClient.setQueryData<T[]>(listKey, (items) =>
        items?.some((item) => item.id === id)
          ? items.map((item) => (item.id === id ? entity : item))
          : items && [...items, entity],
      )
    })
    .catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'notFound') {
        queryClient.setQueryData<T[]>(listKey, (items) => items?.filter((item) => item.id !== id))
      } else {
        void queryClient.invalidateQueries({ queryKey: listKey, exact: true })
      }
    })
}

function invalidateEntity(client: BatonClient, queryClient: QueryClient, target: NonNullable<ChangeEvent['target']>) {
  const messages = queryClient.getQueryData<Message[]>(keys.messages(target.id)) ?? []
  const messageIds = new Set(messages.map((message) => message.id))
  const items = queryClient.getQueryData<InboxItem[]>(keys.inbox) ?? []
  const itemIds = new Set(items.filter((item) => item.projectId === target.id).map((item) => item.id))
  void queryClient.invalidateQueries({
    predicate: ({ queryKey: [group, kind, id], state }) => {
      if (target.type === 'thread') {
        if (group === 'threads') return kind === 'detail' && id === target.id
        if (group === 'messages')
          return (
            kind === target.id ||
            (kind === 'output' && id === target.id) ||
            (kind === 'trace' && typeof id === 'string' && messageIds.has(id))
          )
        if (group === 'operations') {
          const operation = state.data as Operation | undefined
          if (operation?.kind === 'sendMessage') return messageIds.has(operation.targetId)
          return operation?.kind !== 'answerItem' && operation?.targetId === target.id
        }
      } else {
        if (group === 'projects') return id === target.id
        if (group === 'inbox') return true
        if (group === 'operations') {
          const operation = state.data as Operation | undefined
          return operation?.kind === 'answerItem' && itemIds.has(operation.targetId)
        }
      }
      return false
    },
  })
  if (target.type === 'thread') {
    refreshListItem<Thread>(queryClient, keys.threads, keys.thread(target.id), target.id, () =>
      client.getThread(target.id),
    )
  } else {
    refreshListItem<Project>(queryClient, keys.projects, keys.project(target.id), target.id, () =>
      client.getProject(target.id),
    )
  }
}

export function ClientProvider({ client, children }: { client: BatonClient; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  useEffect(
    () =>
      client.subscribe(({ topics, target, browserEvent }) => {
        if (browserEvent || target || topics.some((topic) => ['threads', 'inbox', 'projects'].includes(topic)))
          void queryClient.invalidateQueries({ queryKey: keys.activity })
        if (target) {
          invalidateEntity(client, queryClient, target)
          return
        }
        for (const topic of topics)
          void queryClient.invalidateQueries({
            queryKey: [topic],
            predicate: ({ queryKey: [group, kind] }) =>
              group !== 'files' && !(group === 'devices' && (kind === 'folders' || kind === 'allowedFolders')),
          })
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

export function useDownloads() {
  const client = useClient()
  return useQuery({ queryKey: keys.downloads, queryFn: () => client.getDownloads(), refetchOnMount: 'always' })
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

export function useMemoryStatus(projectId: ID, active: boolean) {
  const client = useClient()
  return useQuery({
    queryKey: keys.memoryStatus(projectId),
    queryFn: () => client.getMemoryStatus(projectId),
    enabled: active,
    refetchOnMount: 'always',
    refetchInterval: 10000,
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

export function useActivity() {
  const client = useClient()
  return useQuery({
    queryKey: keys.activity,
    queryFn: () => client.getActivity!(),
    enabled: !!client.getActivity,
    refetchOnMount: 'always',
  })
}

export function useInbox() {
  const client = useClient()
  return useQuery({ queryKey: keys.inbox, queryFn: () => client.listInbox() })
}

// 文件内容按需读取；设备不可用时由预览界面隐藏旧正文。
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
    staleTime: 0,
    refetchOnReconnect: false,
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
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: { projectId: ID; status: 'active' | 'paused' | 'archived' }) => client.setProjectStatus(input),
    // 归档会为 Project 的 Thread 保存停止请求，Thread 列表随之刷新。
    onSuccess: (_, { status }) => {
      void cache.invalidateQueries({ queryKey: keys.projects })
      if (status === 'archived') void cache.invalidateQueries({ queryKey: keys.threads })
    },
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
    queryKey: keys.memorySources(projectId, note?.id, note?.version),
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

const refreshDeviceFolders = (cache: QueryClient, deviceId: ID) =>
  Promise.all([
    cache.invalidateQueries({ queryKey: ['devices', 'folders', deviceId] }),
    cache.invalidateQueries({ queryKey: ['devices', 'allowedFolders', deviceId] }),
    cache.invalidateQueries({ queryKey: ['files', deviceId] }),
  ])

export function useAddDeviceFolder() {
  const client = useClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: { deviceId: ID; path: string }) => client.addDeviceFolder(input),
    onSuccess: (_device, { deviceId }) => refreshDeviceFolders(cache, deviceId),
  })
}

export function useRemoveDeviceFolder() {
  const client = useClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: { deviceId: ID; path: string }) => client.removeDeviceFolder(input),
    onSuccess: (_device, { deviceId }) => refreshDeviceFolders(cache, deviceId),
  })
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
  return useMutation({ mutationFn: (nodeId?: ID) => client.createEnrollment(nodeId) })
}
