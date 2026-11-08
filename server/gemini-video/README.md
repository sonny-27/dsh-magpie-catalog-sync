# Gemini 网页视频桥接

将单独授权的 Gemini Apps 网页会话接入 Magpie 的 OpenAI Videos API。它使用 `gemini-webapi==2.1.1`，不使用 Google AI Studio 付费 API，也不读取本机浏览器 Cookie 数据库。已有 Antigravity/Code Assist OAuth 不能代替 Gemini Apps 会话。

容器 API 只绑定宿主机 `127.0.0.1:8012`，Magpie 在共同 Docker 网络中使用 `http://magpie-gemini-video:8010/v1`。`compose.yaml` 假定已有 `searxng-proxy` 网络及 `searxng-clash:7896` HTTP 代理；部署到其他环境时修改网络和代理。将本目录中的 `Dockerfile`、`bridge.py`、`manage.py` 放入部署目录的 `app/`，compose 文件置于其父目录；旁边创建 `data/`，设为容器 UID/GID 10001 可写且权限 0700。

首次运行随机生成 `data/api.key` 和独立的 `data/admin.key`。前者配置给 Magpie 自定义提供商，后者只用于容器内部的会话管理；不要把管理密钥或网页登录 Cookie 给模型客户端。

操作者把专用 Gemini 会话的 `__Secure-1PSID` 和可选 `__Secure-1PSIDTS` 放入受保护的 JSON 文件，容器内运行 `python manage.py /data/incoming-session.json`。导入接口只接受回环地址和管理密钥，验证后原子保存会话，随后删除导入文件。不要在聊天、命令参数或 Git 仓库中填写真实 Cookie。网页会话依然可能失效，届时需要重新授权。

接口：

- `GET /healthz`：仅返回是否已配置及状态，不返回凭据。
- `GET /v1/models`：授权成功后才列出 `gemini-web-video`，标记为 `kind: video`。
- `POST /v1/videos`：提交一次任务，立即返回原任务 ID。
- `GET /v1/videos/{id}`：查询原任务。
- `GET /v1/videos/{id}/content`：完成后下载 MP4，需要同一桥接凭据。

`gemini-web-video` 表示账号网页当前使用的视频模型，并不证明调用了某个 Veo 或 Omni 版本。秒数和比例通过提示传入，不能宣称上游严格接受。最多输入 5 张图片；只接收图片 data URL，不在服务器抓取调用者提供的任意网址或本地路径。DSBot 插件负责本机图片验证与数据转换。

生成最多排队 3 个任务，串行执行；查询不会再次提交生成。没有返回视频、下载失败或下载内容不是 MP4 都记为失败，不降级成图片。重启保留已完成任务，中断的任务标记失败且不自动重提。视频缓存保留 24 小时，上限约 2 GiB（在达到上限前接受的单个任务仍可能使占用增加，单片最多 256 MiB）；参考图在任务结束后删除，任务元数据不保存提示词或 Cookie。

这些行为已通过模拟上游测试；真实视频生成和 Google 下载授权必须用操作者自己的网页账号另行验收，不能将接口测试当作真实出片成功。
