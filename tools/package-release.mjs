import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function releaseTarget(
  version,
  platform = process.platform,
  arch = process.arch,
) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      version ?? "",
    )
  )
    throw new Error("发布版本必须是带 v 前缀的版本号，例如 v0.1.0-alpha.1");
  const target = {
    "linux-x64": "linux-amd64",
    "darwin-arm64": "darwin-arm64",
    "win32-x64": "windows-amd64",
  }[`${platform}-${arch}`];
  if (!target) throw new Error(`尚未支持的发布平台：${platform}-${arch}`);
  const name = `baton-${version}-${target}`;
  return { name, target, extension: platform === "win32" ? ".zip" : ".tar.gz" };
}

export function archiveArgs(
  archive,
  staging,
  name,
  platform = process.platform,
) {
  return [platform === "win32" ? "-acf" : "-czf", archive, "-C", staging, name];
}

export function validateBuildInfo(raw, target, commit) {
  const info = new Map(
    [...raw.matchAll(/^\s*build\s+(\S+)=(\S+)$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const [platform, arch] = target.split("-");
  if (info.get("GOOS") !== platform || info.get("GOARCH") !== arch)
    throw new Error("Go 二进制与发布平台不匹配，请在目标平台重新构建");
  if (info.get("vcs.revision") !== commit)
    throw new Error("Go 二进制与当前源码提交不匹配，请重新运行统一构建");
  return info.get("vcs.modified") !== "false";
}

function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} 执行失败：${result.signal ?? result.status}`);
  return result.stdout?.trim();
}

export async function packageRelease(
  version,
  source = resolve(root, "bin"),
  output = resolve(root, "bin/releases"),
) {
  const { name, target, extension } = releaseTarget(version);
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const staging = await mkdtemp(join(tmpdir(), "baton-release-"));
  const archive = join(staging, name + extension);
  const destination = resolve(output, name + extension);
  try {
    // 只打包明确的程序和 Runtime，避免把 bin 中的临时文件或本地配置带入附件。
    const payload = join(staging, name);
    await mkdir(payload);
    const suffix = process.platform === "win32" ? ".exe" : "";
    let modified = false;
    for (const binary of ["coordinator", "batond"]) {
      const path = join(source, binary + suffix);
      const info = run("go", ["version", "-m", path], { capture: true });
      modified = validateBuildInfo(info, target, commit) || modified;
      await cp(path, join(payload, binary + suffix));
    }
    await cp(join(source, "sidecars"), join(payload, "sidecars"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await cp(join(root, "runtimes/INSTALL.md"), join(payload, "INSTALL.md"));
    await writeFile(
      join(payload, "release.json"),
      JSON.stringify(
        {
          version,
          commit,
          modified,
          target,
          node: ">=22.19.0",
        },
        null,
        2,
      ) + "\n",
    );
    await mkdir(output, { recursive: true });
    // Windows 显式使用系统 bsdtar，避免 Git Bash 的 GNU tar 生成非 zip 文件。
    const tar =
      process.platform === "win32"
        ? win32.join(process.env.SystemRoot, "System32", "tar.exe")
        : "tar";
    run(tar, archiveArgs(archive, staging, name));
    const contents = await readFile(archive);
    const magic =
      extension === ".zip"
        ? Buffer.from([0x50, 0x4b, 0x03, 0x04])
        : Buffer.from([0x1f, 0x8b]);
    if (!contents.subarray(0, magic.length).equals(magic))
      throw new Error("压缩包内容格式与扩展名不匹配");

    // 用最终压缩包解压后的内容验证安装，覆盖压缩过程中的权限和链接变化。
    const extracted = join(staging, "extracted");
    await mkdir(extracted);
    run(tar, ["-xf", archive, "-C", extracted]);
    run(process.execPath, [
      join(root, "tools/check-sidecar-package.mjs"),
      join(extracted, name),
    ]);
    const metadata = JSON.parse(
      await readFile(join(extracted, name, "release.json"), "utf8"),
    );
    if (
      metadata.version !== version ||
      metadata.commit !== commit ||
      metadata.target !== target
    )
      throw new Error("解压后的发布信息不匹配");
    const checksum = createHash("sha256").update(contents).digest("hex");
    await cp(archive, destination);
    await writeFile(
      destination + ".sha256",
      `${checksum}  ${basename(destination)}\n`,
    );
    console.log(`发布包与 SHA-256 校验和已生成：${destination}`);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await packageRelease(
      process.argv[2],
      process.argv[3] ? resolve(process.argv[3]) : undefined,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
