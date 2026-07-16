# Commerce Ops 访问配置

主服务优先读取 `APP_HOST`、`APP_PORT` 和 `APP_ACCESS_TOKEN`。旧的 `HOST`、`PORT` 仍兼容，但优先级更低。前端 API 使用当前页面的 origin，不依赖写死的本机 IP。

## 本机访问

```env
APP_HOST=127.0.0.1
APP_PORT=3101
APP_ACCESS_TOKEN=
```

访问 `http://127.0.0.1:3101`。未配置 Token 时只允许这种回环监听，启动日志会提示当前处于本机兼容模式。

## 局域网访问

```env
APP_HOST=0.0.0.0
APP_PORT=3101
APP_ACCESS_TOKEN=<使用独立的高强度随机值>
```

局域网用户通过 `http://<运行主服务的电脑局域网IP>:3101` 访问，并在锁定页输入同一个 Token。认证不依赖来源 IP，因此可信局域网设备可正常使用。

Windows 防火墙只应向需要访问的专用网络或指定网段开放 TCP `3101`。不要因此开放 SQLite 文件共享、数据库端口、Chrome 调试端口或其他内部服务。

广告页面使用主服务同源路径 `/ads/`，广告接口使用 `/api/ads/*`。浏览器不直接访问 `4173`；广告子服务继续只监听 `127.0.0.1`，因此局域网只需开放 `3101`。未显式配置时，主服务会生成内部 Token 并保存到 Git 已忽略的 `storage/.ad-service-internal-token`，以便服务重启后继续使用；如果广告服务由其他进程单独管理，则两个进程必须配置同一个 `AD_SERVICE_INTERNAL_TOKEN`。

## 云端部署

云端运行至少需要调整：

```env
APP_HOST=0.0.0.0
APP_PORT=3101
APP_ACCESS_TOKEN=<云端独立高强度随机值>
```

安全组或主机防火墙应只开放实际 Web 入口。正式公网使用建议在后续部署阶段增加 HTTPS 反向代理，并限制管理来源；不要直接公开 SQLite、未来 PostgreSQL、Chrome 调试或内部采集端口。

云端仍应让 `AD_SERVICE_HOST=127.0.0.1`，并保持 `4173` 不对公网开放。若主服务与广告服务未来拆到不同机器，需要在后续部署阶段改用受控内网与服务间认证；当前固定代理有意拒绝非回环目标。

Token 只保存在当前浏览器标签页的 `sessionStorage` 中。关闭标签页或点击“退出系统”后会失效；Token 不通过 URL、Cookie 或 `localStorage` 传递。

## 外部网络目标限制

Chrome 页面导航和商品图片代理使用同一套网络安全策略。系统只允许内置的 Lazada、Shopee、TikTok Shop、马帮及对应图片 CDN 域名，并在每次导航、图片请求和重定向前校验 DNS 返回的全部地址。直接 IP、回环地址、私网、链路本地、保留地址、云元数据地址、URL 内嵌凭证及非 HTTP(S) 协议均会被拒绝。

如平台新增正式域名，可通过以下配置追加明确域名：

```env
CHROME_ALLOWED_HOSTS=
IMAGE_PROXY_ALLOWED_HOSTS=
NETWORK_REQUEST_TIMEOUT_MS=20000
CHROME_MAX_REDIRECTS=5
IMAGE_PROXY_MAX_BYTES=10485760
IMAGE_PROXY_MAX_REDIRECTS=3
```

域名之间使用逗号分隔。配置不支持 `*`，也不允许填写完整 URL、IP 地址、`.com`、`.net`、`co.th` 等过宽公共后缀。非法配置会阻止服务启动。图片代理默认最多跟随 3 次经过重复校验的跳转，最大响应体为 10MB，并拒绝 SVG、HTML、JSON、脚本、缺失 Content-Type 和任意二进制响应。
