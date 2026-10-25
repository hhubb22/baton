import { context, transform } from 'esbuild'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function forbiddenPackage(name) {
  return /^(?:@cursor\/sdk(?:[-/]|$)|@t3tools\/provider-[^/]+(?:\/|$)|effect-(?:acp|codex-app-server)(?:\/|$)|@earendil-works\/pi-(?:ai|agent-core|coding-agent)(?:\/|$))/.test(
    name,
  )
}

function forbiddenFile(path) {
  return (
    /(?:^|\/)apps\/batond\/src\/(?:cli\.ts$|cli\/|agents\/probe\.ts$|agent-host\/(?:host|host-layer|driver)\.ts$)/.test(
      path,
    ) ||
    /(?:^|\/)(?:host-module|host-driver|sdk-loader)\.ts$/.test(path) ||
    /(?:^|\/)(?:node_modules\/)?(?:@cursor\/sdk(?:-[^/]+)?|@t3tools\/provider-[^/]+|effect-(?:acp|codex-app-server)|@earendil-works\/pi-(?:ai|agent-core|coding-agent))(?:\/|$)/.test(
      path,
    ) ||
    /(?:^|\/)upstream\/t3code\/packages\/provider-[^/]+(?:\/|$)/.test(path)
  )
}

async function runtimeImports(path, local) {
  const extension = extname(path)
  if (!/\.[cm]?[jt]sx?$/.test(extension)) return []
  const source = await readFile(path, 'utf8')
  // Match the workspace's verbatim module semantics while erasing all type syntax.
  const { code } = await transform(source, {
    sourcefile: path,
    loader: /\.[cm]?ts$/.test(extension) ? 'ts' : /\.[cm]?js$/.test(extension) ? 'js' : extension.slice(1),
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  })
  const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = []
  const loaders = new Set(['require'])
  const creators = new Set()
  const moduleNamespaces = new Set()
  const declarations = []
  function collect(node) {
    if (ts.isImportDeclaration(node) && ['module', 'node:module'].includes(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.name) moduleNamespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === 'createRequire') creators.add(binding.name.text)
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(ast)
  function isLoader(node) {
    return (
      (ts.isIdentifier(node) && loaders.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        node.name.text === 'require')
    )
  }
  function isCreator(node) {
    return (
      (ts.isIdentifier(node) && creators.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        moduleNamespaces.has(node.expression.text) &&
        node.name.text === 'createRequire')
    )
  }
  let previousSize
  do {
    previousSize = loaders.size + creators.size
    for (const { name, initializer } of declarations) {
      if (isCreator(initializer)) creators.add(name.text)
      if (isLoader(initializer)) loaders.add(name.text)
      if (ts.isCallExpression(initializer) && isCreator(initializer.expression)) {
        const base = initializer.arguments[0]
        if (local && (!base || !['import.meta.url', '__filename'].includes(base.getText(ast)))) {
          throw new Error(`Worker dependency graph: non-static createRequire base in ${path}`)
        }
        loaders.add(name.text)
      }
    }
  } while (loaders.size + creators.size !== previousSize)
  function optionalLoad(node) {
    for (let current = node; current.parent; current = current.parent) {
      const parent = current.parent
      if (ts.isFunctionLike(parent)) return false
      if (ts.isTryStatement(parent) && current === parent.tryBlock && parent.catchClause) return true
    }
    return false
  }
  function add(argument, kind, node) {
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      imports.push({ name: argument.text, kind, optional: !local && optionalLoad(node) })
    } else if (local) {
      const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
      throw new Error(`Worker dependency graph: non-static ${kind} in ${path}:${line + 1}:${character + 1}`)
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier, 'import-statement', node)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], 'dynamic-import', node)
      } else if (isLoader(callee)) {
        add(node.arguments[0], 'require-call', node)
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        loaders.has(callee.expression.text) &&
        callee.name.text === 'resolve'
      ) {
        add(node.arguments[0], callee.name.text === 'resolve' ? 'require-resolve' : 'require-call', node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return imports
}

export async function assertWorkerDependencies({ root = repository, external = [] } = {}) {
  root = await realpath(root)
  let resolveImport
  // Only use esbuild's resolver. No rebuild or Worker bundle is produced.
  const resolver = await context({
    absWorkingDir: root,
    stdin: { contents: '' },
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    external,
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'worker-dependency-resolver',
        setup(builder) {
          resolveImport = (name, options) => builder.resolve(name, options)
        },
      },
    ],
  })
  const visited = new Set()
  const pending = ['daemon/worker-runner.ts', 'worker/index.ts'].map((entry) => ({
    path: join(root, 'apps/batond/src', entry),
    chain: [],
  }))
  try {
    for (let index = 0; index < pending.length; index++) {
      const { path, chain } = pending[index]
      const normalized = path.replaceAll('\\', '/')
      const label = relative(root, path).replaceAll('\\', '/')
      const route = [...chain, label]
      if (forbiddenFile(normalized)) {
        throw new Error(`Worker dependency graph: forbidden runtime dependency\n${route.join(' -> ')}`)
      }
      if (visited.has(path)) continue
      visited.add(path)
      const local = !normalized.includes('/node_modules/')
      const dependencies = await runtimeImports(path, local)
      for (const { name, kind, optional } of dependencies) {
        if (forbiddenPackage(name)) {
          throw new Error(`Worker dependency graph: forbidden runtime dependency\n${[...route, name].join(' -> ')}`)
        }
        const result = await resolveImport(name, { importer: path, resolveDir: dirname(path), kind })
        if (result.errors.length) {
          // esbuild keeps missing, caught package loads as external runtime loads.
          if (optional) continue
          throw new Error(
            `Worker dependency graph: cannot resolve ${name}\n${route.join(' -> ')}\n${result.errors.map((error) => error.text).join('\n')}`,
          )
        }
        if (forbiddenFile(result.path.replaceAll('\\', '/')) || forbiddenPackage(result.path)) {
          throw new Error(
            `Worker dependency graph: forbidden runtime dependency\n${[...route, name, result.path].join(' -> ')}`,
          )
        }
        if (!result.external) pending.push({ path: result.path, chain: route })
      }
    }
    return visited
  } finally {
    await resolver.dispose()
  }
}
