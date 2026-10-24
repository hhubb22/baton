import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archiveArgs, releaseTarget, validateBuildInfo } from './package-release.mjs'

const version = 'v0.1.0-alpha.1'
const commit = 'a'.repeat(40)

test('Go 二进制必须与发布平台和源码提交一致，记录未提交修改', () => {
  const info = `binary: go1.27.0\n\tbuild\tGOOS=linux\n\tbuild\tGOARCH=amd64\n\tbuild\tvcs.revision=${commit}\n\tbuild\tvcs.modified=false\n`
  assert.equal(validateBuildInfo(info, 'linux-amd64', commit), false)
  assert.equal(validateBuildInfo(info.replace('modified=false', 'modified=true'), 'linux-amd64', commit), true)
  assert.throws(() => validateBuildInfo(info, 'windows-amd64', commit), /平台不匹配/)
  assert.throws(() => validateBuildInfo(info, 'linux-amd64', 'b'.repeat(40)), /源码提交不匹配/)
  assert.throws(() => validateBuildInfo('', 'linux-amd64', commit), /平台不匹配/)
})
for (const [platform, arch, target, extension] of [
  ['linux', 'x64', 'linux-amd64', '.tar.gz'],
  ['darwin', 'arm64', 'darwin-arm64', '.tar.gz'],
  ['win32', 'x64', 'windows-amd64', '.zip'],
]) {
  test(`发布包按原生平台命名：${target}`, () => {
    assert.deepEqual(releaseTarget(version, platform, arch), {
      name: `baton-${version}-${target}`,
      target,
      extension,
    })
  })
}

test('版本输入拒绝路径、命令及不完整版本号', () => {
  for (const value of [
    undefined,
    '',
    '0.1.0',
    'v0.1',
    'v01.1.0',
    'v0.1.0-alpha/1',
    'v0.1.0;echo secret',
    '../v0.1.0',
    'v0.1.0\n',
  ])
    assert.throws(() => releaseTarget(value, 'linux', 'x64'))
})

test('不把未支持的架构标成已有发布平台', () => {
  for (const [platform, arch] of [
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ])
    assert.throws(() => releaseTarget(version, platform, arch), /尚未支持/)
})

test('压缩包命令将路径作为独立参数传递，Windows 由扩展名选择 zip', () => {
  assert.deepEqual(archiveArgs('/out/package.tar.gz', '/tmp/with spaces', 'payload', 'darwin'), [
    '-czf',
    '/out/package.tar.gz',
    '-C',
    '/tmp/with spaces',
    'payload',
  ])
  assert.deepEqual(archiveArgs('C:\\out\\package.zip', 'C:\\temp folder', 'payload', 'win32'), [
    '-acf',
    'C:\\out\\package.zip',
    '-C',
    'C:\\temp folder',
    'payload',
  ])
})
