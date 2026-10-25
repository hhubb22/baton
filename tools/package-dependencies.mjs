import { cp, mkdir, readFile, realpath, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

function accepts(values, value) {
  if (!values) return true
  if (values.includes(`!${value}`)) return false
  const positive = values.filter((entry) => !entry.startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

export function matchesTarget(metadata, { platform, arch }) {
  return accepts(metadata.os, platform) && accepts(metadata.cpu, arch) && accepts(metadata.libc, 'glibc')
}

export async function packageDirectory(name, from) {
  const require = createRequire(join(resolve(from), 'package.json'))
  // Resolve the package directory without depending on an exported package.json.
  for (const directory of require.resolve.paths(name) ?? []) {
    try {
      const path = await realpath(join(directory, name))
      await readFile(join(path, 'package.json'))
      return path
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  throw new Error(`缺少安装包依赖 ${name}（解析目录：${from}）；请先安装目标平台的依赖，打包不会联网`)
}

// Hoist identical installed packages and retain conflicting versions under their consumer.
// The resulting tree contains physical directories so relocation also works on Windows.
export async function copyProductionDependencies(seeds, output, target) {
  const placements = new Map()
  const copied = []
  await mkdir(output, { recursive: true })
  async function visit(name, source, consumer, ancestors = new Map()) {
    source = await realpath(source)
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (!matchesTarget(metadata, target)) return
    if (ancestors.get(name)?.source === source) return
    const top = join(output, name)
    const search = createRequire(join(consumer, 'package.json')).resolve.paths(name) ?? []
    const nearest = search.map((directory) => placements.get(join(directory, name))).find(Boolean)
    if (nearest?.source === source) return
    const destination = nearest ? join(consumer, 'node_modules', name) : top
    if (placements.get(destination)?.source === source) return
    if (placements.has(destination)) throw new Error(`依赖版本放置冲突：${name}`)
    placements.set(destination, { source })
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== join(source, 'node_modules'),
    })
    copied.push({ name: metadata.name, version: metadata.version, path: relative(dirname(output), destination) })
    const nextAncestors = new Map(ancestors).set(name, { source, destination })
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies }
    for (const dependency of Object.keys(dependencies).sort()) {
      let dependencySource
      try {
        dependencySource = await packageDirectory(dependency, source)
      } catch (error) {
        if (
          Object.hasOwn(metadata.optionalDependencies ?? {}, dependency) ||
          metadata.peerDependenciesMeta?.[dependency]?.optional
        )
          continue
        throw error
      }
      await visit(dependency, dependencySource, destination, nextAncestors)
    }
  }
  for (const { name, from } of seeds) await visit(name, await packageDirectory(name, from), dirname(output))
  return copied
}

export async function bundledPackages(inputs, repository) {
  const found = new Map()
  for (const input of Object.keys(inputs)) {
    if (input.startsWith('disk-pi:')) continue
    let directory = dirname(resolve(repository, input))
    while (directory !== dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (metadata.name) {
          found.set(directory, { name: metadata.name, version: metadata.version ?? 'workspace', path: directory })
          break
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      directory = dirname(directory)
    }
  }
  return [...found.values()]
}

export async function copyDependencyLicenses(modules, output) {
  await mkdir(output, { recursive: true })
  for (const module of modules) {
    const directory = resolve(output, '..', module.path)
    const destination = join(output, module.name.replaceAll('/', '__') + '@' + module.version)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(entry.name)) continue
      await mkdir(destination, { recursive: true })
      await cp(join(directory, entry.name), join(destination, entry.name))
    }
  }
}
