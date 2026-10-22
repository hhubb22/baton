// 模拟延迟和后台事件都经过 Scheduler，测试里换成手动推进的版本，结果可重复。
export interface Scheduler {
  now(): number
  after(ms: number, task: () => void): () => void
  wait(ms: number): Promise<void>
}

export function realScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    after(ms, task) {
      const timer = setTimeout(task, ms)
      return () => clearTimeout(timer)
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

export interface ManualScheduler extends Scheduler {
  // 推进时间并按到期顺序执行任务，任务里新排的到期任务也会执行。
  advance(ms: number): void
  pending(): number
}

export function manualScheduler(start = Date.UTC(2026, 9, 22, 9, 0)): ManualScheduler {
  let current = start
  let sequence = 0
  let tasks: { at: number; order: number; run: () => void }[] = []

  const after = (ms: number, run: () => void) => {
    const task = { at: current + ms, order: sequence++, run }
    tasks.push(task)
    return () => {
      tasks = tasks.filter((item) => item !== task)
    }
  }

  return {
    now: () => current,
    after,
    // 测试里读写不加延迟，直接在微任务里完成。
    wait: () => Promise.resolve(),
    advance(ms) {
      const target = current + ms
      for (;;) {
        const due = tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at || a.order - b.order)[0]
        if (!due) break
        tasks = tasks.filter((task) => task !== due)
        current = due.at
        due.run()
      }
      current = target
    },
    pending: () => tasks.length,
  }
}
