import * as stylex from '@stylexjs/stylex'
import { Navigate, Outlet } from '@tanstack/react-router'
import { useSession } from '../data/queries'
import { colors } from '../theme/tokens.stylex'
import { Sidebar } from './Sidebar'

const styles = stylex.create({
  shell: { display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: colors.canvas },
})

export function WorkspaceLayout() {
  const session = useSession()
  if (session.isPending) return null
  if (!session.data?.account) return <Navigate to="/login" replace />
  return (
    <div {...stylex.props(styles.shell)}>
      <Sidebar />
      <Outlet />
    </div>
  )
}
