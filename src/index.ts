/**
 * dsh-describe-image — Host 半区。
 *
 * 为纯文本模型提供 `describe_image` 工具:一次调用加载一张图片(http(s) URL 或
 * 会话工作区内的本地绝对路径),交给 OpenAI 兼容 / Anthropic 风格的视觉端点,
 * 只把返回文本交给模型——图片字节绝不进入会话记录。
 *
 * 与旧全家桶实现的关键差异(也是本插件存在的理由):
 * 设置走 DSH `0.2.x` 官方的 volatile Config + `configForms` 通道,
 * 因此命名空间会真正暴露给 Web 设置面板,可在 GUI 内编辑,无需重启。
 *
 * 安全边界:
 * - 端点请求与图片下载都拒绝 HTTP 重定向;
 * - 本地路径只在会话工作区内可读(`..` 穿越与符号链接无法逃逸);
 * - 仅按 magic bytes 接受 PNG / JPEG / GIF / WebP;
 * - 错误摘要截断,不回显密钥或本机绝对路径。
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  API_ATTACH_PATH,
  API_CAPABILITY_PATH,
  API_RAW_PATH,
  DEFAULT_API_KEY_ENV,
  DEFAULT_API_STYLE,
  DEFAULT_INTERCEPT_IMAGE_SEND,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROMPT,
  DEFAULT_RENDER_IMAGE_PREVIEW,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTACH_BASE64_CHARS,
  PROTOCOL_NAMESPACE,
  TOOL_NAME,
  asApiStyle,
  endpointURL,
  formatAttachmentNote,
  isImageMimeType,
  nonEmptyString,
  normalizeBaseURL,
  parseAttachmentNote,
  parseAttachmentRefJSON,
  positiveNumber,
  sniffMimeType,
  type ApiStyle,
  type DescribeImageResult,
  type ImageAttachmentRefLike,
  type ImageMediaType,
  type ResolvedEndpoint,
} from './core'

export const name = 'dsh-describe-image'
/**
 * Tool 注册需要 tools 服务;attach/capability 路由需要 connection(apply 时刻必须
 * 就绪,否则路由永久漏注册)。attachments 与 llm 是核心宿主服务,在路由 handler
 * 内按请求时刻 `ctx.get` 惰性解析——这样无 connection 的 headless 部署仍能以
 * 纯工具形态(URL/本地路径)加载,只是没有贴图改写链路。
 */
export const inject = ['tools', 'connection'] as const

/**
 * 设置字段类型。
 *
 * 每个字段都是 `Volatile`:一方面让 SettingsForms 从 Config 自动收集该
 * namespace(没有 volatile 字段时整个 namespace 会被跳过,设置卡恒不可用),
 * 另一方面让运行时通过 `.get()` 读取最新值——GUI 保存后无需重启即时生效。
 */
export interface Config {
  /** 视觉端点根地址;按协议追加路径。 */
  baseURL: Volatile<string | undefined>
  /** 接口协议;默认 `chat-completions`。 */
  apiStyle: Volatile<string>
  /** 视觉模型 id。 */
  model: Volatile<string | undefined>
  /** 内联密钥;本地调试用,建议改用 `apiKeyEnv`。 */
  apiKey: Volatile<string | undefined>
  /** 凭证引用的环境变量名;默认 `VISION_API_KEY`。 */
  apiKeyEnv: Volatile<string>
  /** 模型未传 `prompt` 时的兜底指令。 */
  defaultPrompt: Volatile<string>
  /** 图片字节上限。 */
  maxBytes: Volatile<number>
  /** 输出 token 上限。 */
  maxOutputTokens: Volatile<number>
  /** 单次请求超时(毫秒)。 */
  timeoutMs: Volatile<number>
  /** 纯文本模型收到贴图时是否自动改写为 describe_image 引用;判定在 client 侧。 */
  interceptImageSend: Volatile<boolean>
  /** 会话内是否把 note 引用原地渲染为缩略图;判定在 client 侧。 */
  renderImagePreview: Volatile<boolean>
}

export const Config = Schema.object({
  baseURL: Schema.string().volatile(),
  apiStyle: Schema.string().default(DEFAULT_API_STYLE).volatile(),
  model: Schema.string().volatile(),
  apiKey: Schema.string().volatile(),
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV).volatile(),
  defaultPrompt: Schema.string().default(DEFAULT_PROMPT).volatile(),
  maxBytes: Schema.number().default(DEFAULT_MAX_BYTES).volatile(),
  maxOutputTokens: Schema.number().default(DEFAULT_MAX_OUTPUT_TOKENS).volatile(),
  timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS).volatile(),
  interceptImageSend: Schema.boolean().default(DEFAULT_INTERCEPT_IMAGE_SEND).volatile(),
  renderImagePreview: Schema.boolean().default(DEFAULT_RENDER_IMAGE_PREVIEW).volatile(),
})

/** 与宿主 `@deepseek-ai/dsh-attachment` 服务的鸭子面;不引入宿主类型依赖。 */
interface AttachmentStoreLike {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: ImageMediaType; name?: string }[]): Promise<readonly ImageAttachmentRefLike[]>
  readImage(ref: ImageAttachmentRefLike, signal?: AbortSignal): Promise<{ ref: ImageAttachmentRefLike; data: Uint8Array }>
}

/** 与宿主 `ctx.llm` 服务的鸭子面。 */
interface LlmRuntimeLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: string[] }>
}

/** connection 服务的 fetch 路由注册面(参照 dsh-session-manager 的用法)。 */
interface ConnectionFetchRoute {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** 本插件用到的 Host 上下文形状。 */
interface HostContext extends Context {
  get(name: 'connection'): { fetch: { register(route: ConnectionFetchRoute): void } } | undefined
  get(name: 'attachments'): AttachmentStoreLike | undefined
  get(name: 'llm'): LlmRuntimeLike | undefined
}

/** attach 路由请求体里的一张图片。 */
interface AttachRequestImage {
  mediaType: ImageMediaType
  data: string
  name?: string
}

/** 读取一次调用所需的、已收敛的设置快照。 */
interface SettingsSnapshot {
  baseURL?: string
  apiStyle: ApiStyle
  model?: string
  apiKey?: string
  apiKeyEnv: string
  defaultPrompt: string
  maxBytes: number
  maxOutputTokens: number
  timeoutMs: number
}

/** 从 volatile 引用读取最新设置;回调时调用,不缓存 `.get()` 结果。 */
function readSettings(config: Config): SettingsSnapshot {
  return {
    baseURL: nonEmptyString(config.baseURL.get()),
    apiStyle: asApiStyle(config.apiStyle.get()),
    model: nonEmptyString(config.model.get()),
    apiKey: nonEmptyString(config.apiKey.get()),
    apiKeyEnv: nonEmptyString(config.apiKeyEnv.get()) ?? DEFAULT_API_KEY_ENV,
    defaultPrompt: nonEmptyString(config.defaultPrompt.get()) ?? DEFAULT_PROMPT,
    maxBytes: positiveNumber(config.maxBytes.get(), DEFAULT_MAX_BYTES),
    maxOutputTokens: positiveNumber(config.maxOutputTokens.get(), DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveNumber(config.timeoutMs.get(), DEFAULT_TIMEOUT_MS),
  }
}

/** 校验并解析端点;未配置时给出可操作的错误。 */
function resolveEndpoint(settings: SettingsSnapshot): ResolvedEndpoint {
  if (settings.baseURL === undefined) {
    throw new Error(
      'describe-image: 尚未配置视觉端点。请在「设置 → 插件配置 → 图像理解」中填写接口地址与模型。',
    )
  }
  if (!/^https?:\/\//i.test(settings.baseURL)) {
    throw new Error('describe-image: 接口地址必须是绝对 http(s) URL。')
  }
  if (settings.model === undefined) {
    throw new Error('describe-image: 尚未配置视觉模型 id。请在「图像理解」设置卡中填写模型。')
  }
  const fromEnv = settings.apiKeyEnv === '' ? undefined : nonEmptyString(process.env[settings.apiKeyEnv])
  const apiKey = settings.apiKey ?? fromEnv
  return {
    baseURL: normalizeBaseURL(settings.baseURL),
    apiStyle: settings.apiStyle,
    model: settings.model,
    ...(apiKey === undefined ? {} : { apiKey }),
  }
}

/** 已加载并校验过的图片。 */
interface LoadedImage {
  bytes: Uint8Array
  mimeType: ImageMediaType
}

/** 判断 `target` 是否位于 `root` 之内。 */
function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 收敛已读入内存的字节:非空、不超限、magic-byte 类型门。 */
function finishLoad(bytes: Uint8Array, maxBytes: number, source: string): LoadedImage {
  if (bytes.byteLength === 0) throw new Error(`describe-image: 图片为空:${source}`)
  if (bytes.byteLength > maxBytes) {
    throw new Error(`describe-image: 图片 ${bytes.byteLength} 字节,超过 ${maxBytes} 字节上限。`)
  }
  const mimeType = sniffMimeType(bytes)
  if (mimeType === undefined) {
    throw new Error(`describe-image: 不支持的图片类型(仅 PNG / JPEG / GIF / WebP):${source}`)
  }
  return { bytes, mimeType }
}

/** 下载 http(s) 图片;拒绝重定向。 */
async function loadFromURL(url: string, maxBytes: number, signal: AbortSignal): Promise<LoadedImage> {
  const response = await fetch(url, { redirect: 'error', signal })
  if (!response.ok) throw new Error(`describe-image: 图片下载失败(HTTP ${response.status})。`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new Error(`describe-image: 图片超过 ${maxBytes} 字节上限。`)
  }
  return finishLoad(new Uint8Array(await response.arrayBuffer()), maxBytes, 'URL')
}

/** 读取会话工作区内的本地图片;`..` 与符号链接都无法逃逸。 */
async function loadFromPath(path: string, maxBytes: number, workspace: string | undefined): Promise<LoadedImage> {
  if (!isAbsolute(path)) {
    throw new Error('describe-image: 本地图片必须使用会话工作区内的绝对路径。')
  }
  if (workspace === undefined || workspace.trim() === '') {
    throw new Error('describe-image: 当前会话没有工作区,无法读取本地图片;请改用 http(s) URL。')
  }
  let root: string
  try {
    root = await realpath(workspace)
  } catch {
    throw new Error('describe-image: 会话工作区不可访问。')
  }
  let target: string
  try {
    target = await realpath(path)
  } catch {
    throw new Error('describe-image: 找不到图片文件。')
  }
  if (!isInsideWorkspace(root, target)) {
    throw new Error('describe-image: 图片路径超出会话工作区。')
  }
  const info = await stat(target)
  if (!info.isFile()) throw new Error('describe-image: 目标不是文件。')
  if (info.size > maxBytes) {
    throw new Error(`describe-image: 图片 ${info.size} 字节,超过 ${maxBytes} 字节上限。`)
  }
  return finishLoad(new Uint8Array(await readFile(target)), maxBytes, '本地文件')
}

/** `loadImage` 的参数集合。 */
interface LoadImageOptions {
  maxBytes: number
  workspace: string | undefined
  signal: AbortSignal
  /** 宿主附件存储;note 分支必需。 */
  attachments: AttachmentStoreLike | undefined
}

/**
 * 按来源类型分派图片加载:note 引用、http(s) URL 或会话工作区内的本地路径。
 * @param input - 模型传入的 `image` 参数原文。
 * @param options - 加载参数(上限、工作区、取消信号、附件存储)。
 * @returns 已校验的图片字节与媒体类型。
 */
async function loadImage(input: string, options: LoadImageOptions): Promise<LoadedImage> {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('describe-image: image 参数不能为空。')
  const ref = parseAttachmentNote(trimmed)
  if (ref !== undefined) {
    if (options.attachments === undefined) {
      throw new Error('describe-image: 附件服务不可用,无法读取贴图引用;请改用 http(s) URL 或本地路径。')
    }
    const stored = await options.attachments.readImage(ref, options.signal)
    return finishAttachment(stored, options.maxBytes)
  }
  if (trimmed.startsWith('[')) {
    throw new Error('describe-image: 无法解析的附件引用;应原样回传 [image attachment {...}] 整段文本。')
  }
  if (/^https?:\/\//i.test(trimmed)) return loadFromURL(trimmed, options.maxBytes, options.signal)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error('describe-image: 仅支持 http(s) URL、本地绝对路径或 [image attachment ...] 引用。')
  }
  return loadFromPath(trimmed, options.maxBytes, options.workspace)
}

/**
 * 收敛 note 分支取回的存储字节:大小门照旧;媒体类型以存储侧为准
 * (归一化可能改变编码,magic bytes 仅作交叉核对)。
 */
function finishAttachment(
  stored: { ref: ImageAttachmentRefLike; data: Uint8Array },
  maxBytes: number,
): LoadedImage {
  if (stored.data.byteLength === 0) throw new Error('describe-image: 附件图片为空。')
  if (stored.data.byteLength > maxBytes) {
    throw new Error(`describe-image: 图片 ${stored.data.byteLength} 字节,超过 ${maxBytes} 字节上限。`)
  }
  const mediaType = isImageMimeType(stored.ref.mediaType) ? stored.ref.mediaType : sniffMimeType(stored.data)
  if (mediaType === undefined) throw new Error('describe-image: 附件图片类型不受支持。')
  return { bytes: stored.data, mimeType: mediaType }
}

/** 把图片编码为 data URL(仅用于请求体,不写入任何日志)。 */
function toDataURL(image: LoadedImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`
}

/** 按协议构造请求体。 */
function buildRequestBody(
  endpoint: ResolvedEndpoint,
  image: LoadedImage,
  prompt: string,
  maxOutputTokens: number,
): Record<string, unknown> {
  const dataURL = toDataURL(image)
  if (endpoint.apiStyle === 'chat-completions') {
    return {
      model: endpoint.model,
      max_tokens: maxOutputTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataURL } },
          ],
        },
      ],
    }
  }
  if (endpoint.apiStyle === 'responses') {
    return {
      model: endpoint.model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: dataURL },
          ],
        },
      ],
    }
  }
  return {
    model: endpoint.model,
    max_tokens: maxOutputTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: Buffer.from(image.bytes).toString('base64'),
            },
          },
        ],
      },
    ],
  }
}

/** 按协议构造请求头;密钥只出现在请求头里。 */
function buildHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (endpoint.apiStyle === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (endpoint.apiKey !== undefined) headers['x-api-key'] = endpoint.apiKey
    return headers
  }
  if (endpoint.apiKey !== undefined) headers.authorization = `Bearer ${endpoint.apiKey}`
  return headers
}

/** 从响应体中抽取文本;兼容字符串与分块两种 content 形态。 */
function extractText(payload: unknown, style: ApiStyle): string {
  const record = asRecord(payload)
  if (record === undefined) return ''
  if (style === 'chat-completions') {
    const choices = Array.isArray(record.choices) ? record.choices : []
    const message = asRecord(asRecord(choices[0])?.message)
    return firstText(message?.content) ?? firstText(message?.reasoning_content) ?? ''
  }
  if (style === 'responses') {
    const direct = typeof record.output_text === 'string' ? record.output_text : undefined
    if (direct !== undefined && direct.trim() !== '') return direct
    const output = Array.isArray(record.output) ? record.output : []
    for (const item of output) {
      const text = firstText(asRecord(item)?.content)
      if (text !== undefined) return text
    }
    return ''
  }
  return firstText(record.content) ?? ''
}

/** 把 content 的字符串或分块数组收敛为一段文本。 */
function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    const text = record?.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** 收窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 发起一次视觉请求并返回文本;超时与调用方取消都转成稳定错误。 */
async function callVision(
  endpoint: ResolvedEndpoint,
  image: LoadedImage,
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpointURL(endpoint.baseURL, endpoint.apiStyle), {
      method: 'POST',
      headers: buildHeaders(endpoint),
      body: JSON.stringify(buildRequestBody(endpoint, image, prompt, maxOutputTokens)),
      redirect: 'error',
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`describe-image: 视觉端点返回 HTTP ${response.status}:${raw.slice(0, 200)}`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error('describe-image: 视觉端点返回的不是合法 JSON。')
    }
    const text = extractText(payload, endpoint.apiStyle)
    if (text.trim() === '') {
      throw new Error('describe-image: 视觉端点没有返回文本内容(可能是输出预算被思考耗尽)。')
    }
    return text
  } catch (error) {
    if (signal.aborted) throw new Error('describe-image: 调用已取消。')
    if (controller.signal.aborted) throw new Error(`describe-image: 视觉请求超过 ${timeoutMs}ms 超时。`)
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 收窄 attach 路由请求体:images 数组、合法媒体类型、受上限约束的 base64。
 * @param body - 已解析的 JSON 值。
 * @returns 校验通过的图片列表;任何不符合处返回 `undefined`。
 */
function parseAttachRequest(body: unknown): AttachRequestImage[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const images = (body as Record<string, unknown>).images
  if (!Array.isArray(images) || images.length === 0 || images.length > 16) return undefined
  let total = 0
  const out: AttachRequestImage[] = []
  for (const entry of images) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    if (!isImageMimeType(record.mediaType)) return undefined
    if (typeof record.data !== 'string' || record.data === '') return undefined
    total += record.data.length
    if (total > MAX_ATTACH_BASE64_CHARS) return undefined
    const name = nonEmptyString(record.name)
    out.push({ mediaType: record.mediaType, data: record.data, ...(name === undefined ? {} : { name }) })
  }
  return out
}

/** 把错误收敛为可放进 JSON 的短消息;不回显密钥与本机绝对路径。 */
function toBoundMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.slice(0, 200)
}

/**
 * 注册 attach 路由:批量把 base64 图片写入官方附件存储并返回 note 文本。
 * @param ctx - Host 上下文。
 */
function registerAttachRoute(ctx: HostContext): void {
  ctx.get('connection')?.fetch.register({
    path: API_ATTACH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        return Response.json({ ok: false, error: { message: 'describe-image: 附件存储服务不可用。' } })
      }
      let body: unknown
      try {
        body = JSON.parse(await request.text())
      } catch {
        return new Response('bad request', { status: 400 })
      }
      const images = parseAttachRequest(body)
      if (images === undefined) return new Response('bad request', { status: 400 })
      try {
        const refs = await attachments.saveImages(images.map((image) => ({
          data: new Uint8Array(Buffer.from(image.data, 'base64')),
          mediaType: image.mediaType,
          ...(image.name === undefined ? {} : { name: image.name }),
        })))
        return Response.json({
          ok: true,
          value: { attachments: refs, notes: refs.map((ref) => formatAttachmentNote(ref)) },
        })
      } catch (error) {
        return Response.json({ ok: false, error: { message: `describe-image: 图片入库失败:${toBoundMessage(error)}` } })
      }
    },
  })
}

/**
 * 注册 capability 路由:查询一个 provider/model 是否接受原生图片输入。
 * @param ctx - Host 上下文。
 */
function registerCapabilityRoute(ctx: HostContext): void {
  ctx.get('connection')?.fetch.register({
    path: API_CAPABILITY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const llm = ctx.get('llm')
      if (llm === undefined) {
        return Response.json({ ok: false, error: { message: 'describe-image: llm 服务不可用。' } })
      }
      let body: unknown
      try {
        body = JSON.parse(await request.text())
      } catch {
        return new Response('bad request', { status: 400 })
      }
      const provider = nonEmptyString((body as { provider?: unknown })?.provider)
      const model = nonEmptyString((body as { model?: unknown })?.model)
      if (provider === undefined || model === undefined) return new Response('bad request', { status: 400 })
      try {
        const info = await llm.resolveModelInfo(provider, model, request.signal ?? undefined)
        return Response.json({ ok: true, value: { supportsImages: info.inputModalities?.includes('image') === true } })
      } catch {
        return Response.json({ ok: false, error: { message: 'describe-image: 模型能力查询失败。' } })
      }
    },
  })
}

/**
 * 注册 raw 路由:按引用取回存储字节,供会话内缩略图使用。
 * 引用是内容寻址的(attachmentId 即字节摘要),响应可以永久缓存。
 * @param ctx - Host 上下文。
 */
function registerRawRoute(ctx: HostContext): void {
  ctx.get('connection')?.fetch.register({
    path: API_RAW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        return new Response('attachment store unavailable', { status: 503 })
      }
      const query = new URL(request.url).searchParams.get('ref')
      if (query === null) return new Response('bad request', { status: 400 })
      const ref = parseAttachmentRefJSON(query)
      if (ref === undefined) return new Response('bad request', { status: 400 })
      try {
        const stored = await attachments.readImage(ref, request.signal ?? undefined)
        return new Response(new Uint8Array(stored.data), {
          status: 200,
          headers: {
            'content-type': stored.ref.mediaType,
            'cache-control': 'private, max-age=31536000, immutable',
            etag: `"${stored.ref.attachmentId}"`,
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    },
  })
}

/** 从工具执行上下文解析会话工作区(用于本地路径围栏)。 */
function workspaceOf(exec: unknown): string | undefined {
  const agent = asRecord(exec)?.agent
  const header = asRecord(asRecord(asRecord(agent)?.session)?.header)
  const cwd = header?.cwd
  return typeof cwd === 'string' ? cwd : undefined
}

/**
 * 注册 `describe_image` 工具与贴图链路的两个 Host 路由。图片永不进入会话,
 * 只有视觉模型的文本答案返回给模型。设置经 volatile 引用每次调用重新读取,
 * 因此设置卡的修改立刻到达下一次调用。
 * @param ctx - 携带工具注册表与 connection 服务的 Host 上下文。
 * @param config - 部署配置(volatile 引用)。
 */
export function apply(ctx: HostContext, config: Config): void {
  registerAttachRoute(ctx)
  registerCapabilityRoute(ctx)
  registerRawRoute(ctx)
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Inspect one image and return the text the user needs, analyzed by a vision-language model at the endpoint configured in DSH settings. The image may be an http(s) URL, an absolute local path inside the session workspace, or an [image attachment {...}] note from the conversation. When the user\'s message contains an [image attachment {...}] note (inserted automatically when a text-only model receives a pasted image), pass that entire note string verbatim as the image argument. Always pass a precise `prompt` (e.g. "transcribe all text", "extract the table as CSV", "diagnose the UI layout problems", "translate the text into Chinese") instead of relying on the default description. Only the returned text enters the conversation; the image bytes never do.',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: 'An http(s) URL, an absolute local image path inside the session workspace, or an [image attachment {...}] note copied verbatim from the conversation (PNG, JPEG, GIF, or WebP).',
      },
      prompt: {
        type: 'string',
        description: 'Your precise instruction for the vision model about this image.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          model: { type: 'string', required: true },
          image: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec): Promise<DescribeImageResult> {
      const settings = readSettings(config)
      const endpoint = resolveEndpoint(settings)
      const image = await loadImage(args.image, {
        maxBytes: settings.maxBytes,
        workspace: workspaceOf(exec),
        signal: exec.signal,
        attachments: ctx.get('attachments'),
      })
      const text = await callVision(
        endpoint,
        image,
        args.prompt ?? settings.defaultPrompt,
        settings.maxOutputTokens,
        settings.timeoutMs,
        exec.signal,
      )
      return {
        text,
        model: endpoint.model,
        image: args.image,
        mimeType: image.mimeType,
        bytes: image.bytes.byteLength,
      }
    },
  }))
}

export { PROTOCOL_NAMESPACE }