# dsh-describe-image — 图像理解插件

为**纯文本模型**提供模型侧 `describe_image` 工具:每次调用加载一张图片(http(s) URL
或会话工作区内的本地绝对路径),交给 OpenAI 兼容 / Responses / Anthropic Messages
风格的视觉语言端点,只把返回文本交给模型——**图片字节绝不进入会话记录**。

## 为什么有独立的一份

现有第三方全家桶图像理解插件的浏览器半区通过
`webUiSettings.bind()` 读写设置。该桥接带一份硬编码的命名空间 allowlist
(只列 ssh / task-board / remote-web-ui / market 等),插件自身的 namespace 不在表里,
会被 `composeAllowlist` 过滤,于是设置卡恒显示「当前部署未暴露此命名空间,无法在此编辑」。

本插件改用 DSH `0.2.x` 的官方通道,从根上避免这个问题:

| 关注点 | 旧全家桶桥接 | 本插件 |
| --- | --- | --- |
| Host 设置来源 | 手工注册 namespace | 导出含 `.volatile()` 字段的 Config,由 SettingsForms 自动收集 |
| namespace | 取决于桥接内部映射 | profile entry id(`cordis.patch.yml` 的 `insert.id`) |
| Client 读取 | `webUiSettings.bind({ namespace })` | `ctx.configForms.get(entryId)` |
| 是否会被 allowlist 过滤 | 会 | 不会 |

关键前提:**Config 必须有 volatile 字段**。全部是普通字段时,SettingsForms 会整体跳过该
namespace,即使插件已加载、GUI 也拿不到——这与命名无关,改名救不回来。

## 能力

- **两种输入**:http(s) URL(拒绝重定向)或会话工作区内的本地绝对路径。
- **三种协议**:`chat-completions`(默认)、`responses`、`anthropic-messages`。
- **设置卡即时生效**:设置 → 插件配置 → 「图像理解」;保存后无需重启,下一次调用即读取新值。
- **密钥两种来源**:内联 `apiKey`,或 `apiKeyEnv` 引用的环境变量(默认 `VISION_API_KEY`)。
- **安全边界**:请求与下载均拒绝重定向;本地路径经 `realpath` 围栏,`..` 与符号链接都无法逃逸;
  仅按 magic bytes 接受 PNG / JPEG / GIF / WebP;有 `maxBytes` / `maxOutputTokens` / `timeoutMs` 上限;
  错误摘要截断且不回显密钥。
- **规范输出**:`{ text, model, image, mimeType, bytes }`——模型只看到 `text`。

## 设置字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | 空(必须填写) | 端点根地址;按协议追加 `/chat/completions`、`/responses` 或 `/v1/messages` |
| `apiStyle` | `chat-completions` | 接口协议 |
| `model` | 空(必须填写) | 视觉模型 id,例如 `qwen-vl-max`、`glm-4v`、`gpt-4o-mini` |
| `apiKey` | 空 | 内联密钥,建议仅本地调试 |
| `apiKeyEnv` | `VISION_API_KEY` | 凭证环境变量名 |
| `defaultPrompt` | 内置英文指令 | 模型未传 `prompt` 时的兜底 |
| `maxBytes` | `10485760` | 图片字节上限 |
| `maxOutputTokens` | `1024` | 输出 token 上限 |
| `timeoutMs` | `120000` | 单次请求超时 |

## 兼容性

- DSH:`>=0.2.0-rc.2`(在 `0.2.1-rc.2` 上验证)
- Cordis:`~4.0.5`
- Schemastery:`~3.18.5`
- dsh-tools:`0.2.1-rc.2`

同一 cohort 的版本要成组确认,不要只升级其中一个 alpha/rc 包。

## 开发与质量门禁

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:settings    # 隔离诊断:确认命名空间会被 SettingsForms 投影且字段可写
node /path/to/dsh-plugin-development/scripts/validate.mjs .
npm pack --dry-run
```

`pnpm verify:settings` 深导入本机 DSH 安装里的 `dsh-settings` 内部 schema 助手,只用于
本机诊断(该助手未公开导出),不会进入插件的运行时依赖,也不随包发布。

## 安装到 profile

```bash
pnpm build
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-describe-image
# 或从 tarball:dsh plugin --profile <profile> add /absolute/path/to/dsh-describe-image-0.1.0.tgz

dsh --profile <profile> --dump-config   # 确认 describe-image 行已插入
```

与上一代全家桶插件**不要同时启用**:两者都注册工具名 `describe_image`,会冲突。
迁移时先停用旧的第三方图像理解插件。

## 已知边界

- 不处理输入框粘贴/拖拽产生的附件引用:本插件只接受 URL 与工作区内本地路径。
  需要「贴图即用」的附件上传管线时,仍需额外的 client 改写与 Host 附件路由。
- 本地路径要求会话有工作区;无工作区时会话只能用 URL。

## 来源与版权

本插件为原创实现,参考 `deepseek-harness` 的 `describe_image` 工具契约与上一代
第三方全家桶图像理解插件的能力边界,按其设置通道缺陷改用官方
`configForms` 方案重建。许可证:MIT。