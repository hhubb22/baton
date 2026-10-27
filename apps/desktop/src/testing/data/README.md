# 证书测试数据

这些公开证书由本目录中的 OpenSSL 命令生成，用于离线验证接入链接和桌面客户端的 CA 信任范围。仓库只保存 `.crt`，私钥、CSR 和扩展配置均在临时目录生成，退出时删除。测试不运行 OpenSSL，也不访问网络。

- `ca.crt`：固定信任的根 CA，有效期 3650 天。
- `other-ca.crt`：另一把密钥生成的根 CA，与固定 CA 使用相同 subject。
- `intermediate.crt`：固定 CA 签发的中间 CA，有效期 5 天。
- `leaf.crt`：中间 CA 签发的服务器证书，有效期 30 天。
- `direct-leaf.crt`：固定 CA 直接签发的服务器证书，有效期 5000 天，用于单独验证根 CA 过期。
- `other-leaf.crt`：另一 CA 签发的服务器证书。
- `non-ca-child.crt`：由 `leaf.crt` 的密钥签发，用于拒绝非 CA 签发者。
- `client-leaf.crt`：固定 CA 签发的仅供客户端认证的证书。
- `constrained.crt`、`constrained-leaf.crt`：名称约束只允许 `allowed.test` 的中间 CA，及它签发的 `coordinator.test` 证书；用于拒绝当前无法完整执行的名称约束。
- `sub-ca.crt`、`sub-leaf.crt`：在 pathlen 为 0 的中间 CA 下再签发一个 CA 与叶子，用于验证路径长度限制。

叶子证书的 SAN 包含 `coordinator.test`、`*.coordinator.test`、`127.0.0.1` 和 `::1`。测试时间从证书的有效期推导，避免依赖运行当天的日期。生成会使用新密钥，证书字节及 SHA-256 指纹会变化。

从仓库根目录执行，要求 OpenSSL 3 或更高版本：

```sh
set -eu
out="$PWD/apps/desktop/src/testing/data"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

printf '%s\n' \
  'basicConstraints=critical,CA:TRUE,pathlen:0' \
  'keyUsage=critical,keyCertSign,cRLSign' \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' > intermediate.ext
printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:coordinator.test,DNS:*.coordinator.test,IP:127.0.0.1,IP:::1' \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' > leaf.ext
printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=clientAuth' \
  'subjectAltName=DNS:coordinator.test' > client.ext

for name in ca other-ca; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
    -keyout "$name.key" -out "$out/$name.crt" -days 3650 \
    -subj '/CN=Baton Desktop Test CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash'
done

issue() {
  name=$1 issuer=$2 days=$3 extensions=$4
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name"
  openssl x509 -req -in "$name.csr" -CA "$out/$issuer.crt" -CAkey "$issuer.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days "$days" \
    -extfile "$extensions" -out "$out/$name.crt"
}
issue intermediate ca 5 intermediate.ext
issue leaf intermediate 30 leaf.ext
issue direct-leaf ca 5000 leaf.ext
issue other-leaf other-ca 30 leaf.ext
issue non-ca-child leaf 30 leaf.ext
issue client-leaf ca 30 client.ext
printf '%s\n' \
  'basicConstraints=critical,CA:TRUE,pathlen:0' \
  'keyUsage=critical,keyCertSign,cRLSign' \
  'nameConstraints=critical,permitted;DNS:allowed.test' > constrained.ext
issue constrained ca 5 constrained.ext
issue constrained-leaf constrained 30 leaf.ext
issue sub-ca intermediate 5 intermediate.ext
issue sub-leaf sub-ca 30 leaf.ext
```
