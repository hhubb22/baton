import { useNavigate, useParams } from '@tanstack/react-router'
import { ThreadDetail } from '../app/ThreadDetail'

// 单独打开的 Thread。恢复办法回到 Threads 页顶部的新对话输入区。
export function ThreadPage() {
  const { threadId } = useParams({ from: '/workspace/threads/$threadId' })
  const navigate = useNavigate()
  return (
    <ThreadDetail
      key={threadId}
      threadId={threadId}
      layout="page"
      onRecover={(action, thread) =>
        void navigate({
          to: '/threads',
          search: { compose: action === 'chooseFolder' ? 'folder' : 'focus', from: thread.id },
        })
      }
    />
  )
}
