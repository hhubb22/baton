import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  changePassword,
  getMe,
  getNodeFiles,
  getNodes,
  issueEnrollment,
  login,
  logout,
  messageOf,
  putDefaultDevice,
  revokeNode,
} from './api.ts'
import { applyRevoke, applySavedDefault } from './model.ts'
import { clearCSRF, readCSRF, writeCSRF } from './session.ts'
import type { Employee, Enrollment, NodeList, SavedDefault } from './types.ts'
import { LoginForm } from './ui/LoginForm.tsx'
import { NodesPage } from './ui/NodesPage.tsx'
import { SessionsPage } from './ui/SessionsPage.tsx'
import { ProjectsPage } from './ui/ProjectsPage.tsx'
import { TasksPage } from './ui/TasksPage.tsx'
import { taskURL } from './tasks.ts'
import { PasswordForm } from './ui/PasswordForm.tsx'

type Phase =
  | { kind: 'loading' }
  | { kind: 'login'; notice?: string }
  | { kind: 'password'; employee: Employee; csrf: string }
  | { kind: 'nodes'; employee: Employee; csrf: string }

export default function App() {
  const [page, setPage] = useState<'nodes' | 'sessions' | 'tasks' | 'projects'>(() => routePage())
  const [taskID, setTaskID] = useState(() => window.location.pathname.split('/')[2] ?? '')
  const [projectID, setProjectID] = useState(() => window.location.pathname.split('/')[2] ?? '')
  function navigateProject(id: string) {
    window.history.pushState(null, '', id ? `/projects/${encodeURIComponent(id)}` : '/projects')
    setProjectID(id); setPage('projects')
  }
  function navigateTask(id: string) {
    window.history.pushState(null, '', id ? taskURL(id) : '/tasks')
    setTaskID(id); setPage('tasks')
  }
  function navigatePage(next: 'nodes' | 'sessions') {
    window.history.pushState(null, '', '/'); setPage(next)
  }
  useEffect(() => {
    const change = () => { setTaskID(window.location.pathname.split('/')[2] ?? ''); setProjectID(window.location.pathname.split('/')[2] ?? ''); setPage(routePage()) }
    window.addEventListener('popstate', change)
    return () => window.removeEventListener('popstate', change)
  }, [])
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [list, setList] = useState<NodeList | null>(null)
  const [saved, setSaved] = useState<SavedDefault | null>(null)
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const listGen = useRef(0)
  const origin = window.location.origin

  useEffect(() => {
    let stop = false
    const csrf = readCSRF()
    void getMe()
      .then((me) => {
        if (stop) return
        if (me.employee.must_change_password) {
          setPhase({ kind: 'password', employee: me.employee, csrf })
          return
        }
        setPhase({ kind: 'nodes', employee: me.employee, csrf })
      })
      .catch(() => {
        if (stop) return
        clearCSRF()
        setPhase({ kind: 'login' })
      })
    return () => {
      stop = true
    }
  }, [])

  useEffect(() => {
    if (phase.kind !== 'nodes') return
    let stop = false
    const load = () => {
      const gen = ++listGen.current
      void getNodes()
        .then((fresh) => {
          if (!stop && gen === listGen.current) setList(fresh)
        })
        .catch((err: unknown) => {
          if (stop) return
          if (err instanceof ApiError && err.status === 401) {
            enterLogin(err.message)
          }
        })
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [phase])

  function enterLogin(notice?: string) {
    clearCSRF()
    setEnrollment(null)
    setSaved(null)
    setList(null)
    setError('')
    setPhase(notice ? { kind: 'login', notice } : { kind: 'login' })
  }

  async function onLogin(username: string, password: string) {
    setBusy(true)
    setError('')
    try {
      const result = await login(username, password)
      writeCSRF(result.csrf_token)
      if (result.employee.must_change_password) {
        setPhase({ kind: 'password', employee: result.employee, csrf: result.csrf_token })
        return
      }
      setPhase({ kind: 'nodes', employee: result.employee, csrf: result.csrf_token })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onPassword(currentPassword: string, newPassword: string) {
    if (phase.kind !== 'password' || !phase.csrf) return
    setBusy(true)
    setError('')
    try {
      await changePassword(phase.csrf, currentPassword, newPassword)
      enterLogin('口令已更换，请用新口令重新登录。')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onLogout() {
    if (phase.kind !== 'nodes' || !phase.csrf) return
    setBusy(true)
    setError('')
    try {
      await logout(phase.csrf)
      enterLogin('已退出。')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRefresh() {
    setError('')
    const gen = ++listGen.current
    try {
      const fresh = await getNodes()
      if (gen === listGen.current) setList(fresh)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        enterLogin(err.message)
        return
      }
      setError(messageOf(err))
    }
  }

  async function onIssue() {
    if (phase.kind !== 'nodes' || !phase.csrf) return
    setBusy(true)
    setError('')
    try {
      const issued = await issueEnrollment(phase.csrf)
      setEnrollment(issued)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveDefault(nodeId: string) {
    if (phase.kind !== 'nodes' || !phase.csrf) return
    setBusy(true)
    setError('')
    try {
      const result = await putDefaultDevice(phase.csrf, nodeId)
      setSaved(result)
      listGen.current += 1
      setList((current) => (current ? applySavedDefault(current, result) : current))
      const gen = ++listGen.current
      const fresh = await getNodes()
      if (gen === listGen.current) setList(fresh)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRevoke(nodeId: string) {
    if (phase.kind !== 'nodes' || !phase.csrf) return
    setBusy(true)
    setError('')
    try {
      const result = await revokeNode(phase.csrf, nodeId)
      listGen.current += 1
      setList((current) => (current ? applyRevoke(current, result) : current))
      const gen = ++listGen.current
      const fresh = await getNodes()
      if (gen === listGen.current) setList(fresh)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  if (phase.kind === 'loading') return <p className="page">正在确认登录状态。</p>

  return (
    <main className="page">
      {phase.kind === 'login' ? (
        <LoginForm notice={phase.notice ?? ''} error={error} busy={busy} onSubmit={(username, password) => void onLogin(username, password)} />
      ) : null}
      {phase.kind === 'password' ? (
        <>
          <header className="top">
            <h1>Baton</h1>
          </header>
          {!phase.csrf ? (
            <p className="error" role="alert">这个标签页没有 CSRF 令牌，不能更换口令。请重新登录。</p>
          ) : null}
          <PasswordForm
            username={phase.employee.username}
            error={error}
            busy={busy}
            canWrite={phase.csrf !== ''}
            onSubmit={(currentPassword, newPassword) => void onPassword(currentPassword, newPassword)}
          />
          {!phase.csrf ? (
            <button data-testid="relogin" type="button" onClick={() => enterLogin()}>重新登录</button>
          ) : null}
        </>
      ) : null}
      {phase.kind === 'nodes' ? (
        <>
        <nav aria-label="页面"><button type="button" onClick={() => navigateProject('')}>Project</button><button type="button" onClick={() => navigatePage('nodes')}>节点</button><button type="button" onClick={() => navigatePage('sessions')}>Session</button><button type="button" onClick={() => navigateTask('')}>任务</button></nav>
        {page === 'projects' ? <ProjectsPage key={phase.employee.id} id={projectID} csrf={phase.csrf} employeeID={phase.employee.id} navigate={navigateProject} navigateTask={navigateTask} /> : page === 'tasks' ? <TasksPage key={phase.employee.id} id={taskID} csrf={phase.csrf} employeeID={phase.employee.id} nodes={list} navigate={navigateTask} /> : page === 'sessions' ? <SessionsPage csrf={phase.csrf} nodes={list} employeeID={phase.employee.id} /> : <NodesPage
          employee={phase.employee}
          csrf={phase.csrf}
          list={list}
          saved={saved}
          enrollment={enrollment}
          busy={busy}
          error={error}
          origin={origin}
          onRefresh={() => void onRefresh()}
          onLogout={() => void onLogout()}
          onRelogin={() => enterLogin()}
          onIssue={() => void onIssue()}
          onDismissEnrollment={() => setEnrollment(null)}
          onSaveDefault={(nodeId) => void onSaveDefault(nodeId)}
          onRevoke={(nodeId) => void onRevoke(nodeId)}
          loadFiles={(nodeId, query) => getNodeFiles(nodeId, query)}
        />}
        </>
      ) : null}
    </main>
  )
}

function routePage(): 'nodes' | 'tasks' | 'projects' {
  return window.location.pathname.startsWith('/projects') ? 'projects' : window.location.pathname.startsWith('/tasks') ? 'tasks' : 'nodes'
}
