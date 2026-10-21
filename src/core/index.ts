/**
 * dsh-describe-image — 跨端共享的纯逻辑与协议常量。
 *
 * 只放类型、常量和无环境依赖的纯函数;不得引用 `node:*`、DOM 或任何
 * Host/Client 单例,以便被 Host 测试与 Client 测试分别加载。
 */

/** 跨端协议命名空间(预留给未来的 Host/Client RPC)。 */
export const PROTOCOL_NAMESPACE = 'dsh:describe-image' as const

/**
 * 设置命名空间。
 *
 * 必须与 `cordis.patch.yml` 的 `insert.id` 完全一致:DSH `0.2.x` 的
 * SettingsForms 用 profile entry id 作为 namespace,并从插件导出的 Config
 * 自动收集 volatile 字段。Client 侧用同一个字符串调用
 * `ctx.configForms.get(...)`;它不是包名,也不是 `export const name`。
 */
export const SETTINGS_NAMESPACE = 'dsh-describe-image' as const

/** 模型可见的工具名。 */
export const TOOL_NAME = 'describe_image' as const

/** 接受的图片媒体类型(稳定顺序)。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/** 支持的接口协议。 */
export const API_STYLES = ['chat-completions', 'responses', 'anthropic-messages'] as const
export type ApiStyle = (typeof API_STYLES)[number]

export const DEFAULT_API_STYLE: ApiStyle = 'chat-completions'
export const DEFAULT_API_KEY_ENV = 'VISION_API_KEY'
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024
export const DEFAULT_TIMEOUT_MS = 120_000
/** 纯文本模型收到贴图时是否自动改写为 describe_image 引用(仅 `false` 视为关闭)。 */
export const DEFAULT_INTERCEPT_IMAGE_SEND = true

/** Host attach 路由:批量把 base64 图片入官方附件存储,返回引用。 */
export const API_ATTACH_PATH = '/api/dsh-describe-image/attach' as const
/** Host capability 路由:查询一个 provider/model 是否接受原生图片输入。 */
export const API_CAPABILITY_PATH = '/api/dsh-describe-image/capability' as const

/** capability 查询结果为「支持图片」时的客户端缓存时长。 */
export const CAPABILITY_TTL_MS = 30_000
/** capability 探测的超时;卡住的 Host 不得卡住一次发送。 */
export const CAPABILITY_TIMEOUT_MS = 1_500
/** attach 路由单次请求的 base64 字符总量上限(约 48MiB 原始字节;/api 桥另有 300MiB 兜底)。 */
export const MAX_ATTACH_BASE64_CHARS = 64 * 1024 * 1024

/** 贴图引用 note 的首尾标记;模型把它整段回传给 `describe_image` 的 `image` 参数。 */
export const ATTACHMENT_NOTE_PREFIX = '[image attachment ' as const
export const ATTACHMENT_NOTE_SUFFIX = ']' as const

/**
 * 与宿主 `@deepseek-ai/dsh-attachment` 的 `ImageAttachmentRef` 对齐的可序列化形状。
 * 只保留普通字段,client bundle 可安全加载(不 import 宿主类型)。
 */
export interface ImageAttachmentRefLike {
  /** 存储侧 opaque 标识;不是文件路径,也不是带凭证的 URL。 */
  attachmentId: string
  /** 存储侧按字节校验过的媒体类型。 */
  mediaType: ImageMediaType
  /** 精确编码字节长度。 */
  bytes: number
  /** 编码后的固有宽度(像素)。 */
  width: number
  /** 编码后的固有高度(像素)。 */
  height: number
  /** 去除了本地路径信息的展示名。 */
  name?: string
  /** 归一化缩放前的输入尺寸;仅在归一化缩小过图片时存在。 */
  originalDimensions?: { width: number; height: number }
}

/** modelSelection 投影里的一次模型选型。 */
export interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 模型未传 `prompt` 时的兜底指令。 */
export const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, transcribe it verbatim; if it is a chart or table, extract its data; if it is a UI screenshot, report the layout and any visible problems.'

/** 工具返回给模型的规范值;图片字节绝不进入会话记录。 */
export interface DescribeImageResult {
  /** 视觉模型返回的文本,也就是模型唯一能看到的内容。 */
  text: string
  /** 实际使用的视觉模型 id。 */
  model: string
  /** 调用方传入的图片来源(原样回显,便于审计)。 */
  image: string
  /** 由 magic bytes 判定的媒体类型。 */
  mimeType: ImageMediaType
  /** 图片字节数。 */
  bytes: number
}

/** 一次调用解析出的端点配置。 */
export interface ResolvedEndpoint {
  baseURL: string
  apiStyle: ApiStyle
  model: string
  apiKey?: string
}

/** 是否是可接受的图片媒体类型。 */
export function isImageMimeType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * 由 magic bytes 判定图片类型,不解码图片本身。
 * @param bytes - 输入的起始字节。
 * @returns 可接受的媒体类型;未知或截断时返回 `undefined`。
 */
export function sniffMimeType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && ascii(bytes, 0, 6) === 'GIF87a') return 'image/gif'
  if (bytes.length >= 6 && ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** 读取一段 ASCII 字节,用于 magic-byte 比较。 */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index] ?? 0)
  return out
}

/** 去掉首尾空白与末尾斜杠,得到稳定的端点根地址。 */
export function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 按协议把根地址规范化为完整请求 URL。
 * @param baseURL - 端点根地址。
 * @param style - 接口协议。
 * @returns 完整请求 URL。
 */
export function endpointURL(baseURL: string, style: ApiStyle): string {
  const root = normalizeBaseURL(baseURL)
  if (style === 'chat-completions') return `${root}/chat/completions`
  if (style === 'responses') return `${root}/responses`
  return root.endsWith('/v1') ? `${root}/messages` : `${root}/v1/messages`
}

/** 把未知输入收敛为正的有限数字,否则返回兜底值。 */
export function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 把未知输入收敛为非空字符串,否则返回 `undefined`。 */
export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 把未知输入收敛为受支持的协议,否则返回默认协议。 */
export function asApiStyle(value: unknown): ApiStyle {
  return typeof value === 'string' && (API_STYLES as readonly string[]).includes(value)
    ? (value as ApiStyle)
    : DEFAULT_API_STYLE
}

/**
 * 把一条附件引用序列化为 note 文本。
 * @param ref - 存储侧返回的引用。
 * @returns `[image attachment {...}]` 形态的完整文本。
 */
export function formatAttachmentNote(ref: ImageAttachmentRefLike): string {
  const json = JSON.stringify(ref)
  return `${ATTACHMENT_NOTE_PREFIX}${json}${ATTACHMENT_NOTE_SUFFIX}`
}

/**
 * 解析模型回传的 note 文本;防御式收窄,任何不符合处返回 `undefined`。
 * @param input - 模型作为 `image` 参数传回的原文。
 * @returns 校验通过的引用;无法解析时返回 `undefined`。
 */
export function parseAttachmentNote(input: string): ImageAttachmentRefLike | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith(ATTACHMENT_NOTE_PREFIX) || !trimmed.endsWith(ATTACHMENT_NOTE_SUFFIX)) {
    return undefined
  }
  const payload = trimmed.slice(ATTACHMENT_NOTE_PREFIX.length, trimmed.length - ATTACHMENT_NOTE_SUFFIX.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const attachmentId = nonEmptyString(record.attachmentId)
  const mediaType = isImageMimeType(record.mediaType) ? record.mediaType : undefined
  const bytes = positiveInteger(record.bytes)
  const width = positiveInteger(record.width)
  const height = positiveInteger(record.height)
  if (attachmentId === undefined || mediaType === undefined || bytes === undefined
    || width === undefined || height === undefined) {
    return undefined
  }
  const name = nonEmptyString(record.name)
  const originalDimensions = readOriginalDimensions(record.originalDimensions)
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...(name === undefined ? {} : { name }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

/** 把未知输入收敛为正整数,否则返回 `undefined`。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 收窄 `originalDimensions`;任一字段非法则整体丢弃。 */
function readOriginalDimensions(value: unknown): { width: number; height: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const width = positiveInteger((value as Record<string, unknown>).width)
  const height = positiveInteger((value as Record<string, unknown>).height)
  return width === undefined || height === undefined ? undefined : { width, height }
}

/**
 * 读取「发送改写」开关;缺省与非法值都视为开启。
 * @param value - 设置快照里的 `interceptImageSend` 原始值。
 * @returns 仅当显式为 `false` 时返回 `false`。
 */
export function isInterceptEnabled(value: unknown): boolean {
  return value !== false
}