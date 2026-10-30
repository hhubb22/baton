# 本地网络测试证书

`environment-cert.pem` 和 `environment-key.pem` 是仅用于回环网络测试的自签名证书及公开测试私钥，不用于真实服务或账号。证书覆盖 `localhost` 和 `127.0.0.1`，由以下命令生成：

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout environment-key.pem -out environment-cert.pem \
  -days 36500 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

环境网络测试使用临时代理和 HTTPS/WebSocket 服务验证 CA、代理及 `NO_PROXY`，不访问外网。
