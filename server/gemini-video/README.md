# Gemini 网页视频桥接

## 多账号

默认 Compose 启用 `GEMINI_MULTI_ACCOUNT=1`，使用一个 API 地址、Key 和 `gemini-web-video` 模型聚合多个独立网页账号。原 `data/` 与 `browser-profile/` 继续作为“账号1”，保持原 Key 和任务 ID；新账号的状态在 `data/accounts/<id>/`，浏览器资料在 `browser-profiles/<id>/`。账号名称由操作者填写，不自动读取 Google 邮箱，也不注册新的 Google 账号。

将 `account_pool.py` 一并放入 `app/` 构建；将 `provision_accounts.py` 放入宿主机部署目录。在操作者电脑运行 `multi_login_portal.py`，提供与单账号门户相同的 SSH 参数，并用 `--provision-command "python3 /部署目录/provision_accounts.py /部署目录 {account}"` 配置按需启动钩子。命令模板来自操作者 CLI；网页只传递服务器生成并验证过的账号 ID。不要把 Docker socket 挂入视频 API 容器。

管理页支持添加、重命名、停用新任务、设默认、启动/重试浏览器。默认上限 5 个账号，可由 `GEMINI_MAX_ACCOUNTS` 调整（最大 20）；每个浏览器共享同一镜像层，但有独立持久化目录。新增浏览器只连接原内部网络，不发布 GUI、VNC 或调试端口。

新任务策略可选：

- `priority`：优先默认账号，跳过未登录或已停用账号。
- `round_robin`：在会话就绪且启用的账号间轮询，轮询位置随设置保存。

策略选择只在提交前发生。任务 ID 绑定原账号，后续查询和下载不重新选择；切换默认、停用或更名不会迁移或重新提交任务。停用不会删除会话资料，并且保留旧任务下载。队列最多 3 个、缓存约 2 GiB 的限制对所有账号合计生效。

账号策略是此服务器入口的全局设置，影响所有使用该视频入口的新任务。后续更新整个部署时，应同时传入基础 Compose 文件和生成的 `accounts.compose.json`；账户浏览器的配置保存在独立挂载目录中。若额外容器未启动，可在管理页对相应账号使用“启动/重试”，无需重建账号目录。

“会话就绪”不代表已查询到剩余视频额度；不会因为额度或生成错误而跨账号自动重提。每个窗口固定使用一个 Google 账号，有任务运行时不要在该窗口更换登录身份。多个登录窗口使用不同的本机端口与账号专属管理 Cookie，彼此不能借用浏览器管理会话。真实多账号授权、视频生成与下载需本人登录后另行验收。

将单独授权的 Gemini Apps 网页会话接入 Magpie 的 OpenAI Videos API。它使用 `gemini-webapi==2.1.1`，不使用 Google AI Studio 付费 API，也不读取操作者电脑的个人浏览器资料。已有 Antigravity/Code Assist OAuth 不能代替 Gemini Apps 会话。

容器 API 只绑定宿主机 `127.0.0.1:8012`，Magpie 在共同 Docker 网络中使用 `http://magpie-gemini-video:8010/v1`。`compose.yaml` 假定已有 `searxng-proxy` 网络及 `searxng-clash:7896` HTTP 代理；部署到其他环境时修改网络和代理。将 `Dockerfile`、`bridge.py`、`manage.py`、`browser_session.py`、`proxy.py` 放入部署目录的 `app/`，compose 文件置于其父目录；旁边创建 `data/` 和 `browser-profile/`，设为容器 UID/GID 10001 可写且权限 0700。构建镜像并启动 Compose 后，只有此部署的专用浏览器会参与会话管理。

浏览器使用固定摘要的 `jlesage/chromium:v26.10.1`。它只在内部网络中运行，不发布 GUI、VNC 或 CDP 端口。一个固定 TCP 中继仅将浏览器代理流量送往配置的 HTTP 代理，不接受调用者选择目标；视频桥接加入内部网络，用 CDP 读取 Gemini 页面的两项会话 Cookie，并将网页播放器的下载内容以有界数据块传回任务文件。

## 浏览器登录与自动保存

1. 在操作者电脑上准备 Python 及 `paramiko`，并预先核验服务器 SSH 主机密钥，将其加入受信任的 `known_hosts`。
2. 运行 `python login_portal.py --host <服务器> --known-hosts <受信任文件> --setup-dir <私密运行目录>`。可使用 SSH 密钥，或在终端私密输入 SSH 密码；不要把密码写入命令参数。门户只监听 `127.0.0.1`。
3. 打开门户的 `/setup` 页面，点击「打开网页登录窗口」。首次 Chromium 欢迎页可选择 `Stay signed out` 跳过浏览器同步，再在 Gemini 网页登录 Pro 账号。专用配置中只登录要使用的这一个账号，使用默认的第一个账号。
4. 后台会验证会话并自动保存。回到 `/setup` 查看状态。部署者可通过 `--after-authorize <固定管理命令>` 指定成功后启用 Magpie 提供商的钩子；该命令只来自操作者 CLI，不接受网页输入。

会话只从这一个专用浏览器读取，不扫描其他浏览器或账号。验证前不发布可用视频模型；失败会退回待登录，并限制重复验证频率。网页登录负责刷新 Cookie，SDK 的主动刷新在浏览器模式关闭，避免使浏览器会话失效。退出登录后阻止新的视频任务。浏览器配置目录与会话文件均持久化，更新容器继续复用；Google 撤销会话或要求额外验证时仍需要本人重新登录。

门户的浏览器页面要求 HttpOnly/SameSite 管理会话，打开窗口的表单必须携带来源令牌；显式外站来源被拒绝。原生 WebView 在表单导航中省略 Origin 时，仍必须通过私有表单令牌校验。WebSocket 转发同样要求管理会话并拒绝外站 Origin。SSH 身份使用 RejectPolicy，不自动接受未知服务器密钥。浏览器控制权限与模型客户端的网关 Key 分开。

Google 密码、二次验证、CAPTCHA 和首次使用确认均由本人完成。登录成功不等于视频功能已验收，仍需检查账号的视频入口和额度，再测试真实生成及 MP4 下载。下载失败、登录页 HTML 或空文件不会被标为生成成功。

首次运行随机生成 `data/api.key` 和独立的 `data/admin.key`。前者配置给 Magpie 自定义提供商，后者只用于容器内部的会话管理；不要把管理密钥或网页登录 Cookie 给模型客户端。

`manage.py browser-status` 返回不含凭据的会话状态，`manage.py browser-start` 请求检查专用浏览器。它们在容器内通过回环管理接口与独立管理密钥通信。兼容旧部署时，去掉 `GEMINI_BROWSER_CDP` 可继续用受保护文件导入会话；默认的浏览器模式不接受手动导入，避免混用两套刷新状态。真实会话、浏览器配置与密钥都不能放入 Git 仓库。

接口：

- `GET /healthz`：仅返回是否已配置及状态，不返回凭据。
- `GET /v1/models`：授权成功后才列出 `gemini-web-video`，标记为 `kind: video`。
- `POST /v1/videos`：提交一次任务，立即返回原任务 ID。
- `GET /v1/videos/{id}`：查询原任务。
- `GET /v1/videos/{id}/content`：完成后下载 MP4，需要同一桥接凭据。

`gemini-web-video` 表示账号网页当前使用的视频模型，并不证明调用了某个 Veo 或 Omni 版本。秒数和比例通过提示传入，不能宣称上游严格接受。最多输入 5 张图片；只接收图片 data URL，不在服务器抓取调用者提供的任意网址或本地路径。DSBot 插件负责本机图片验证与数据转换。

生成最多排队 3 个任务，串行执行；查询不会再次提交生成。没有返回视频、下载失败或下载内容不是 MP4 都记为失败，不降级成图片。重启保留已完成任务，中断的任务标记失败且不自动重提。视频缓存保留 24 小时，上限约 2 GiB（在达到上限前接受的单个任务仍可能使占用增加，单片最多 256 MiB）；参考图在任务结束后删除，任务元数据不保存提示词或 Cookie。

这些行为已通过模拟上游、会话保存和隧道测试；真实视频生成和 Google 下载授权必须用操作者自己的网页账号另行验收，不能将接口测试当作真实出片成功。

参考：[Chromium 容器](https://github.com/jlesage/docker-chromium)、[Gemini 网页客户端](https://github.com/HanaokaYuzu/Gemini-API)、[浏览器视频下载说明](https://github.com/FarisHijazi/gemini-web-api#video-veo-status)。本桥接的浏览器下载实现使用逐块传输，避免将整段视频编码后一次性放进协议消息。
