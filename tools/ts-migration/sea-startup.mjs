import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { dependencyRequire, buildSea, environment, isolatedEnv, stats } from './common.mjs'

const requireDependency = dependencyRequire()
const { build } = requireDependency('esbuild')
const effectVersion = requireDependency('effect/package.json').version
if (effectVersion !== '4.0.6') throw new Error(`Expected effect 4.0.6; got ${effectVersion}`)
const samples = Number(process.argv[2] ?? 100)
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('Samples must be a positive integer')
const root = mkdtempSync(join(tmpdir(), 'baton-sea-'))
try {
  const buildDirectory = join(root, 'build')
  const runDirectory = join(root, 'installed')
  mkdirSync(buildDirectory)
  mkdirSync(runDirectory)
  const bundle = join(buildDirectory, 'worker.cjs')
  await build({
    stdin: {
      contents: `
      import { Effect } from 'effect';
      import { DatabaseSync } from 'node:sqlite';
      import { createServer } from 'node:net';
      if (process.argv[2] !== 'worker') throw new Error('Expected worker subcommand');
      const [endpoint, databasePath, token] = process.argv.slice(3);
      Effect.runSync(Effect.sync(() => {
        const db = new DatabaseSync(databasePath);
        db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE thread_meta (id INTEGER PRIMARY KEY)');
        const server = createServer(socket => {
          let buffer = '';
          socket.on('data', chunk => {
            buffer += chunk.toString();
            if (!buffer.includes('\\n')) return;
            if (JSON.parse(buffer).auth !== token) { socket.destroy(); return; }
            socket.end('ready\\n');
            server.close(() => db.close());
          });
        });
        server.listen(endpoint, () => process.stdout.write('listening\\n'));
      }));
    `,
      resolveDir: requireDependency.resolve('effect/package.json').replace(/[/\\]package\.json$/, ''),
      sourcefile: 'worker-scaffold.mjs',
    },
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    outfile: bundle,
    minify: true,
    logLevel: 'silent',
  })
  const executable = join(runDirectory, process.platform === 'win32' ? 'batond.exe' : 'batond')
  await buildSea(bundle, executable)
  // Only the executable is present at the installation path during measurement.
  rmSync(buildDirectory, { recursive: true })
  const listening = []
  const authenticated = []
  for (let i = 0; i < samples; i++) {
    const home = join(runDirectory, `sample-${i}`)
    mkdirSync(home, { mode: 0o700 })
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\baton-sea-${randomUUID()}` : join(home, 'ipc.sock')
    const token = randomUUID()
    await new Promise((resolve, reject) => {
      const started = performance.now()
      const child = spawn(executable, ['worker', endpoint, join(home, 'thread.db'), token], {
        cwd: home,
        env: isolatedEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let errors = ''
      let socket
      let ready = false
      let timer
      const fail = (error) => {
        clearTimeout(timer)
        socket?.destroy()
        child.kill('SIGKILL')
        reject(error)
      }
      timer = setTimeout(() => fail(new Error('SEA IPC timeout (10s)')), 10_000)
      child.on('error', fail)
      child.stderr.on('data', (chunk) => {
        errors += chunk
      })
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (socket || !output.includes('listening\n')) return
        listening.push(performance.now() - started)
        socket = createConnection(endpoint, () => socket.write(`${JSON.stringify({ auth: token })}\n`))
        let response = ''
        socket.on('error', fail)
        socket.on('data', (chunk) => {
          response += chunk
          if (!ready && response.includes('ready\n')) {
            ready = true
            authenticated.push(performance.now() - started)
          }
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0 || !ready) reject(new Error(`SEA failed: exit=${code} ready=${ready} ${errors.slice(0, 2000)}`))
        else resolve()
      })
    })
    rmSync(home, { recursive: true })
  }
  console.log(
    JSON.stringify(
      {
        ...environment(),
        effectVersion,
        esbuildVersion: requireDependency('esbuild/package.json').version,
        executableBytes: statSync(executable).size,
        samples,
        firstListenMs: listening[0],
        firstAuthenticatedMs: authenticated[0],
        listen: stats(listening),
        authenticated: stats(authenticated),
        cache:
          'Fresh processes and fresh SQLite files; OS page cache is not flushed. First sample is reported separately.',
        exceeds3Seconds: Math.max(...authenticated) > 3000,
      },
      null,
      2,
    ),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
