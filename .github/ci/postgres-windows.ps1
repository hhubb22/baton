param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:RUNNER_TEMP 'postgres-17.6-1/pgsql/bin'
$data = Join-Path $env:RUNNER_TEMP "baton-pg-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if ($Stop) {
  if (Test-Path (Join-Path $data 'postmaster.pid')) {
    & "$bin/pg_ctl.exe" -D $data -m fast -w stop
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 清理失败' }
  }
  exit 0
}
if (!(Test-Path "$bin/postgres.exe")) {
  $zip = Join-Path $env:RUNNER_TEMP 'postgres.zip'
  Invoke-WebRequest 'https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip' -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'd378882abd001a186735acd6f6ba716bca6ccd192e800412d4fd15ed25376b3e') {
    throw 'PostgreSQL 下载摘要不匹配'
  }
  # 只解压运行需要的目录，缓存目录内不创建数据库。
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/' -or $entry.FullName.EndsWith('/')) { continue }
      $target = Join-Path (Split-Path (Split-Path $bin)) $entry.FullName
      New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally { $archive.Dispose() }
  Remove-Item $zip
}
$version = & "$bin/postgres.exe" --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'postgres (PostgreSQL) 17.6') { throw "PostgreSQL 版本异常: $version" }
Write-Output $version
"BATON_TEST_POSTGRES_BINDIR=$bin" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
$bin | Out-File $env:GITHUB_PATH -Append -Encoding utf8
if (Test-Path $data) { throw '测试数据目录已经存在' }
& "$bin/initdb.exe" -D $data -U postgres -A trust --locale=C --encoding=UTF8
if ($LASTEXITCODE -ne 0) { throw 'initdb 失败' }
@('host all all 127.0.0.1/32 trust', 'host all all ::1/128 trust') | Set-Content "$data/pg_hba.conf"
& "$bin/pg_ctl.exe" -D $data -l "$data/server.log" -w -o '-h 127.0.0.1 -p 55432' start
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 启动失败' }
& "$bin/createdb.exe" -h 127.0.0.1 -p 55432 -U postgres baton_test
if ($LASTEXITCODE -ne 0) { throw '创建测试库失败' }
$actual = & "$bin/psql.exe" -h 127.0.0.1 -p 55432 -U postgres -d baton_test -Atc 'SHOW server_version'
if ($LASTEXITCODE -ne 0 -or $actual -notmatch '^17\.6') { throw "实际数据库版本异常: $actual" }
"PostgreSQL：$actual；全新数据目录：$data；安装缓存：$env:PG_CACHE_HIT" | Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
