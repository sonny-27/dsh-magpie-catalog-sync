# Magpie 订阅 0.4.6

为 DSBot / DeepSeek Harness 同步模型列表、上下文、输出上限、视觉能力和推理档位。每个模型只生成一个条目；速度与模型、思考强度分开保存。

0.4.6 修复参考图编辑：本机的图片路径和 DSBot 无扩展名附件对象先经宿主图片服务验证，再转换成图片 data URL 上传给 Magpie，远端不再收到无法读取的客户端路径。新增 `edit_image` 工具，要求至少一张参考图；原有 `generate_image` 也支持本地参考图。读取失败会返回明确的工具错误，不提交生成请求；工具说明要求 Bot 报告错误，不能擅自改成纯文字重画。插件不会自动执行这种降级，但模型是否遵循说明仍取决于所用模型。

本地读取只允许附件库和已登记工作区，检查真实路径、防止链接越界，拒绝网络共享、设备路径和非图片文件。每次最多 16 张，单张最多 10 MiB，上传图片数据合计最多 20 MiB；这是本机桥接限制，上游仍可能有自己的限制。支持 PNG、JPEG、WebP、GIF，复用宿主图片验证与归一化；宿主缺少该服务时会明确报错。HTTP(S) 和图片 data URL 继续支持。重启应用加载更新后，插件会刷新原生工具绑定，无需更换 API 地址或 Key。生成中的任务继续查询原任务，不重复提交。

0.4.5 将 Antigravity Gemini 4 的兼容处理改为**完整保留参数说明**：把 Schema 节点中的 `description` 按原 JSON Pointer 路径附到工具总说明中，保留每一条文字、换行、单位和适用条件，不再丢弃说明。全部工具、参数名、必填项、类型、枚举、引用和校验约束均保留。工具本身的原说明保持为总说明的完整前缀，`enum` / `const` / `default` 中的数据不做改写。

GUI 开关为「模型兼容 → Gemini 4 完整参数说明兼容」，沿用原 `gemini4CompactTools` 配置。开启时调整说明位置，关闭时按原位置透传；两种模式都保留完整文字。其他模型按原样转发。诊断字段 `relocatedParameterDescriptions` 表示搬移数量，代替旧版的删除数量字段。

这一兼容处理针对已复现的 Gemini 4 High 复杂工具请求。完整保留 52 个工具、172 条参数说明后，同一历史回放两次完成；说明依赖的微秒单位和只读标签对照测试也通过。它替代 0.4.4 删除参数注释的有损缓解方式。说明位置变化仍可能影响模型理解，不能据此承诺所有任务准确率完全一致，也不代表所有上游流中断都由同一原因引起。

DSH 会在上下文中扣除适配器 `maxTokens` 作为默认输出预留，不能把输入与输出共享的总窗口同时填成这一预留值。0.4.1 遇到上游输出额度大于或等于总上下文时，将默认输出预留调整为窗口的 1/8、最多 32768，并在诊断记录中保留原值。例如：256K 总窗口可以预留 32K 供输出，输入与输出仍共享 256K。该数值是客户端默认预算，并非模型独立的物理输出上限。实际上下文以部署服务公布的元数据为准。

## GUI：连接、绘图与搜索

入口：**DSBot 账户菜单 → Bot 设置 → Harness 设置 → Magpie 订阅**。原版 DSH 在原生设置中打开「Magpie 订阅」。

0.4.2 修复首次安装未提供 Key 时的配置死锁：此时状态为 `needs_configuration`，GUI 可正常填写地址和 Key；验证并保存后会在当前进程自动建立代理、同步模型。设置页只等待本地配置加载，不等待代理或上游请求。Key 保存在宿主凭据服务中，不要求插件数据目录里存在密钥文件。

- 一个 Magpie API 地址和 Key，统一用于模型、搜索与绘图。已保存的网关 Key 不回传浏览器；留空保留，更换地址时要求提供该地址的 Key，先验证后保存。
- 默认每 300 秒同步新模型及 GPT/Gemini 绘图版本，可调整周期、暂停或立即同步。暂停不禁用已缓存的模型。
- 分别选择 GPT、Gemini 绘图版本和默认来源。DSBot 使用原生 MCP 工具库，自动加入主 Bot、全部 Bot，或只加入工具库后手动分配。原版 DSH 的自动工具绑定需要相应客户端工具库支持；目前自动绑定只适配 DSBot。
- 搜索复用原生 `web_search`、`web_fetch`，经 Magpie 网关执行。可选模型搜索优先或搜索 API 优先，分别设置模型回退顺序、API 顺序与 API 启用开关。**搜索排序修改服务器全局配置，影响所有使用该网关的客户端**。不同类别不能任意穿插排序；Magpie 还保留其原生的配额回退策略。
- 绘图桥接仅转发原生 Magpie MCP，限制为选择的 GPT/Gemini 版本，不提供视频生成。工具库中的本机令牌由插件自动管理，用户无须填写第二个 Key。

绘图需网关公开 `/mcp/magpie/image` 及其签名图片文件路径。搜索排序需部署 `server/search-policy.py` 扩展，仅开放 `/v1/magpie/subscription/search-policy`，使用指定的同一网关 Key 鉴权；扩展通过内网原生管理 API 保存排序，不暴露管理 API 或其凭据。扩展可单独部署为 Docker 服务；代码与凭据应通过独立挂载提供，凭据仅保存在宿主机私密目录。升级时继续复用持久化挂载；若 Magpie 原生管理接口变更，则需更新扩展。

集成验收覆盖了 GPT 和 Gemini 的真实出图。具体可用版本、账号权限及额度以你自己的 Magpie 自动发现结果为准。

当前 Codex 订阅的 `gpt-image-2.5`（含 Flare / Sunburst）、`gpt-image-2.6` 经 Magpie 原生 `magpie/media_model` 验证均归一为 `codex/gpt-image-2`，因此 GUI 标注「Magpie 统一入口」。该结论限定于当前 Magpie MCP；DSH Codex 订阅插件另有直接向 Codex 绘图 API 试传 2.5 型号的实验选项，其 UI 也注明未确认实际型号或质量生效。不能用请求型号或成功出图证明上游采用了指定版本。别名解析随定时同步重新核对。

## DSBot 中的使用

1. 安装并完整退出 DSBot（包括托盘），重新打开。
2. 为 Bot 选择「Magpie · 自动同步」下的模型。
3. 思考强度使用 DSBot 原生滑块。
4. 点击滑块旁的小闪电，在模型实际支持的「默认 / Fast / Ultra Fast」中选择。

Fast 使用单闪电；Ultra Fast 使用叠加双闪电。默认速度图标为灰色，加速时点亮。切换速度不改变 Bot 的模型 ID，也不改变思考档位；不同 Bot 的设置彼此独立。

请求通过本机转发器，按当前 Bot / 对话设置自动填入 `service_tier=priority` 或 `ultrafast`。模型字段始终保持原始 ID，不再生成 Fast、Ultra Fast 或思考 Ultra 的模型分身。

旧版 0.1/0.2 的模型分身在 DSBot 界面加载后通过原生接口自动合并，保留既有速度、手动思考档位和旧 Ultra 默认值。迁移期间只临时保留正在使用的旧 ID，迁移完成后从目录移除。SDK 无法表达的思考档位不会被伪装成别的原生档位。

## 安装

Node.js 22.19+。DSBot 0.3.1 / DSH 0.2.2 支持按会话自动传递速度。旧 DSH 0.1.5 可同步模型能力及使用 profile 级速度默认值，其适配器没有按会话请求头扩展，不能保证按 Bot 区分速度。

通过 GUI 首次配置时，可以省略 `--upstream` 和 `--key-file`：

```powershell
node scripts/install-local.mjs --home C:/Users/你的用户/.ds-bot --profile ds-bot
```

重启应用加载插件后，在「Magpie 订阅」中填写连接信息即可。也可在安装时预先提供地址和本机私密的 Key 文件：

```powershell
node scripts/install-local.mjs --home C:/Users/你的用户/.ds-bot --profile ds-bot --upstream https://api.example.com:18443/v1 --key-file C:/私密目录/magpie.key
```

原版 DSH 使用实际 DSH_HOME 和 profile。安装器备份 package.json，添加本地 bundle 与目录链接，不修改 app.asar，不更换 SDK，也不重启应用。归档解压后同样可运行该安装器。密钥首次启动导入原生凭据服务，随后删除私密启动密钥文件。

如果网关漏报已经真实验证的加速能力，可额外传入与网关绑定的能力文件：

```powershell
node scripts/install-local.mjs --home C:/Users/你的用户/.ds-bot --profile ds-bot --upstream https://api.example.com:18443/v1 --key-file C:/私密目录/magpie.key --capabilities-file C:/私密目录/verified-capabilities.json
```

提供的能力文件只对其 `upstream` 精确匹配的网关生效。本次验证 GPT-6.1-Sol 的 Ultra Fast 为 HTTP 200 且 Magpie `tier_sent=ultrafast`；GPT-6-Sol 的同类请求被降为 priority，因此未为它补充 Ultra Fast。普通 HTTP 200 本身不足以证明实际发出了 Ultra Fast。

## 自动同步与配置

默认启动时同步，此后每 5 分钟刷新。暂时断网会保留最近有效目录，不清空其他供应商或切换现有 Bot。

每个 profile 独立保存于：

```text
<DSH_HOME>/dsh-magpie-catalog-sync/<profile>/
  config.json                 网关、凭据引用和刷新周期
  catalog.json                最近有效模型目录
  tool-catalog.json           最近发现的绘图版本与搜索工具
  tool-token.txt              私密的本机绘图工具令牌
  verified-capabilities.json  可选，绑定网关的已验证补充能力
  selections.json             每个 Bot / 模型的速度和迁移默认值
  status.json                 最近同步与请求诊断
```

```json
{
  "upstream": "https://api.example.com:18443/v1",
  "providerId": "magpie-sync",
  "credentialRef": "MAGPIE_CATALOG_SYNC_KEY",
  "pollSeconds": 300,
  "api": "openai-responses"
}
```

密钥不写入此 JSON，使用原生凭据引用。Bot 新的对话分段和群聊会话从其本地会话索引关联回所属 Bot，只使用模型和会话 ID，不向网关附带 Bot 状态或对话索引。自定义 Bot 数据目录可设置 `botStatePath`。

旧 DSH 没有 profileContext 服务，本地安装器会保存不含密钥的 instance.json 明确指定 Home/profile；因此旧版建议使用本地安装器。应用正常更新保留宿主机数据和本插件配置。

## 本机诊断接口

订阅 GUI 的 `/api/magpie-subscription-*` 接口使用宿主 connection.fetch 的会话鉴权；未登录访问返回 401。旧速度诊断接口仅接受本机与同源请求，不返回网关 Key：

- `GET /api/dsh-magpie-catalog-sync/status`：同步状态与最后请求的模型、速度、思考档位。
- `GET /api/dsh-magpie-catalog-sync/controls`：模型能力和当前速度设置。
- `POST /api/dsh-magpie-catalog-sync/sync`：立即同步。
- `POST /api/dsh-magpie-catalog-sync/selection`：保存速度设置。
- `POST /api/dsh-magpie-catalog-sync/reconcile`：完成旧 ID 合并。

POST 需请求头 `X-Magpie-Catalog-Sync: 1`。速度设置示例：

```json
{"botId":"session-your-bot","model":"codex/gpt-6.1-sol","tier":"ultrafast","sessionIds":["session-your-bot"]}
```

`tier` 为空字符串表示默认。原版 DSH 的 profile 级默认可使用保留的 `botId="__profile_default__"`。速度选择只写插件偏好，不改 Bot 模型配置。上游请求验证 TLS，不跟随携带密钥的重定向。

## 界面与验证

思考滑块与保存逻辑均为 DSBot 原生实现。该菜单没有公开控件插槽，小闪电使用有结构检查的菜单适配层，匹配中英文菜单；不替换滑块。DSBot 将来改变菜单结构时，该适配层可能需要更新。

```powershell
npm ci
npm run build
npm test
```

测试覆盖目录唯一性、模型 ID 不变的双速度切换、按 Bot 隔离、持久化、分段继承、旧 ID 迁移、SSE、鉴权和前端加载格式。已通过原生 SDK 验证同一 GPT-6.1-Sol ID 发送 ultrafast 并保留 Low 档位。

速度能力以模型、账号和网关实际处理为准，Fast/Ultra Fast 可能增加额度消耗。插件不承诺固定吞吐倍数。卸载时移除 bundle、依赖及插件管理的 magpie-sync 供应商；凭据可在原生密钥管理中单独删除。

## 凭据与发布

仓库只包含源码、通用测试和文档，不含已配置的网关地址、运行状态、账号数据或真实 Key。单元测试中的认证值均为虚构测试数据。安装时自行提供 `--upstream` 与本机私密的 `--key-file`，或在已连接的客户端 GUI 中配置。

`.gitignore` 排除了运行配置、凭据、证书、缓存和安装归档。不要将 DSH Home、服务器配置目录或完整验收输出复制进仓库。服务端扩展所需的 `gateway.key`、`admin.key` 由部署者另行保存并只读挂载。

## 0.4.3 自检与手动绘图挂载

设置页提供搜索自检、绘图连接自检和真实出图自检。真实出图会消耗上游额度；任务生成中持续查询同一个任务，不重复提交。结果显示配置、上游鉴权及工具发现、本机代理和真实调用的分阶段状态；不回传密钥、图片数据或签名下载地址。

自动添加范围只决定向哪些 Bot 补充绘图能力，不会移除给其他 Bot 手动挂载的工具，避免定时同步中断生成。全局关闭绘图仍会移除此插件的挂载。
