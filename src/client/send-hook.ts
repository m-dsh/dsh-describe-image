/**
 * dsh-describe-image — 发送拦截(Client 半区)。
 *
 * 纯文本模型在 Host admission 处拒绝图片块(`MODEL_DOES_NOT_SUPPORT_IMAGES`,
 * 浏览器横幅「当前模型不支持图片」)。本钩子原地包裹 conversation 服务的
 * `sendSession`:当发送携带图片草稿、且目标模型不接受图片输入时,先把图片
 * 经 Host attach 路由写入官方附件存储,再把发送改写为携带
 * `[image attachment {...}]` 引用文本的纯文本发送——模型随后通过
 * `describe_image` 工具按引用取回图片内容。
 *
 * 失败策略:任何一步失败(读取、上传、能力探测异常)都回落为原样发送,
 * 保持宿主原生行为;钩子安装失败(服务面缺失)则静默不装。所有 DOM/运行时
 * 接线错误只记录,绝不抛出——Web shell 在插件 apply 抛错时会失败整个 boot。
 *
 * @module dsh-describe-image/client/send-hook
 */

import {
  API_ATTACH_PATH,
  API_CAPABILITY_PATH,
  CAPABILITY_TIMEOUT_MS,
  CAPABILITY_TTL_MS,
  formatAttachmentNote,
  isImageMimeType,
  isInterceptEnabled,
  nonEmptyString,
  type ImageAttachmentRefLike,
  type ModelSelectionLike,
} from '../core'

/** 一条图片草稿(conversation 服务的结构面)。 */
interface ImageDraft {
  readonly id: string
  readonly kind: 'image'
  readonly file: File
}

/** conversation 服务的鸭子面;任一方法缺失则钩子静默不装。 */
export interface ConversationServiceLike {
  sendSession(
    session: unknown,
    text: string,
    attachmentIds: readonly string[],
    mode: unknown,
    signal?: AbortSignal,
  ): Promise<{ kind: 'success' | 'error' }>
  resolveDraftAttachments(ids: readonly string[]): readonly { id: string; kind: 'image' | 'file'; file?: File }[]
  releaseDraftAttachments?(attachments: readonly unknown[]): void
  removeAttachment?(id: string): void
}

/** 设置快照源(configForms 的 ConfigForm 面)。 */
export interface SettingsSnapshotSource {
  getSnapshot(): { value?: { interceptImageSend?: boolean } | undefined }
}

/** 已安装标记的键名。 */
const SEND_HOOK_MARKER = '__dshDescribeImageSendHook'

/**
 * 原地包裹 `conversation.sendSession`。幂等(marker 防重);经 `ctx.effect`
 * 注册还原(区分自身属性与原型方法)。
 * @param ctx - 提供 `effect` 的 Client 上下文。
 * @param conversation - conversation 服务实例。
 * @param settings - 设置快照源;`interceptImageSend === false` 时直通。
 */
export function installSendHook(
  ctx: { effect?(register: () => () => void): void },
  conversation: unknown,
  settings: SettingsSnapshotSource | undefined,
): void {
  const target = conversation as Partial<Record<'sendSession' | 'resolveDraftAttachments', unknown>> | undefined
  if (typeof target?.sendSession !== 'function' || typeof target.resolveDraftAttachments !== 'function') return
  if ((target.sendSession as { [SEND_HOOK_MARKER]?: boolean })[SEND_HOOK_MARKER] === true) return

  const original = target.sendSession as ConversationServiceLike['sendSession']
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'sendSession')

  async function hooked(
    this: unknown,
    session: unknown,
    text: string,
    attachmentIds: readonly string[],
    mode: unknown,
    signal?: AbortSignal,
  ): Promise<{ kind: 'success' | 'error' }> {
    const svc = conversation as ConversationServiceLike
    const passthrough = (): Promise<{ kind: 'success' | 'error' }> =>
      original.call(svc, session, text, attachmentIds, mode, signal)
    // 快速直通:已取消、开关关闭。
    if (signal?.aborted === true) return passthrough()
    if (settings !== undefined && !isInterceptEnabled(settings.getSnapshot().value?.interceptImageSend)) {
      return passthrough()
    }
    let drafts: readonly { id: string; kind: 'image' | 'file'; file?: File }[]
    try {
      drafts = svc.resolveDraftAttachments(attachmentIds)
    } catch {
      return passthrough()
    }
    const imageDrafts = drafts.filter(
      (draft): draft is ImageDraft => draft.kind === 'image' && typeof draft.file?.arrayBuffer === 'function',
    )
    if (imageDrafts.length === 0) return passthrough()
    // 支持图片输入的模型直通原生管线;探测失败按纯文本处理(走改写)。
    const selection = readModelSelection(session)
    if (selection !== undefined && await queryCapabilitySupportsImages(selection, fetch)) {
      return passthrough()
    }
    // 改写:全部图片入库成功才改写文本;任一步失败回落原样发送。
    let notes: string[]
    try {
      notes = await uploadImageNotes(imageDrafts, signal)
    } catch {
      return passthrough()
    }
    // 保留非图片(文件)草稿,让它们继续走宿主原生上传管线。
    const keepIds = attachmentIds.filter((id) => !imageDrafts.some((draft) => draft.id === id))
    const joined = notes.join('\n')
    const newText = text.trim() === '' ? joined : `${text}\n${joined}`
    const outcome = await original.call(svc, session, newText, keepIds, mode, signal)
    // 仅成功后释放图片草稿;失败时 composer 需要恢复草稿(宿主语义)。
    if (outcome.kind === 'success') releaseImageDrafts(svc, imageDrafts)
    return outcome
  }

  ;(hooked as unknown as Record<string, unknown>)[SEND_HOOK_MARKER] = true
  target.sendSession = hooked as ConversationServiceLike['sendSession']
  const restore = (): void => {
    if (hadOwn) target.sendSession = original as ConversationServiceLike['sendSession']
    else delete target.sendSession
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => restore)
}

/** 释放已引用的图片草稿;两种服务面都尝试,失败只记录。 */
function releaseImageDrafts(svc: ConversationServiceLike, drafts: readonly ImageDraft[]): void {
  try {
    if (typeof svc.releaseDraftAttachments === 'function') {
      svc.releaseDraftAttachments(drafts)
      return
    }
    if (typeof svc.removeAttachment === 'function') {
      for (const draft of drafts) svc.removeAttachment(draft.id)
    }
  } catch {
    // 非致命:草稿对象 URL 泄漏不影响功能。
  }
}

/**
 * 从 `sendSession` 的 session 实参读取现役模型(modelSelection 投影的
 * `next` = pending ?? lastUsed,与 composer 模型选择器同源)。
 * @param session - 会话结构面。
 * @returns 可读到的选型;读不到返回 `undefined`(按纯文本处理)。
 */
export function readModelSelection(session: unknown): ModelSelectionLike | undefined {
  const projections = (session as { projections?: { faceOf?: (key: string) => { getSnapshot?: () => unknown } | undefined } })?.projections
  const face = typeof projections?.faceOf === 'function' ? projections.faceOf('modelSelection') : undefined
  const snapshot = typeof face?.getSnapshot === 'function' ? face.getSnapshot() : undefined
  const next = typeof snapshot === 'object' && snapshot !== null ? (snapshot as { next?: unknown }).next : undefined
  if (typeof next !== 'object' || next === null) return undefined
  const provider = nonEmptyString((next as { provider?: unknown }).provider)
  const model = nonEmptyString((next as { model?: unknown }).model)
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

/** capability 肯定结果的模块级缓存;失败不缓存以便重试。 */
const capabilityCache = new Map<string, number>()

/**
 * 查询一个 provider/model 是否接受原生图片输入。
 * @param selection - 目标模型选型。
 * @param fetchLike - fetch 实现(测试可注入)。
 * @returns 是否支持;任何失败按不支持处理(fail-closed,走改写)。
 */
export async function queryCapabilitySupportsImages(
  selection: ModelSelectionLike,
  fetchLike: typeof fetch,
): Promise<boolean> {
  const key = `${selection.provider}::${selection.model}`
  const cached = capabilityCache.get(key)
  if (cached !== undefined && cached > Date.now()) return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CAPABILITY_TIMEOUT_MS)
  try {
    const response = await fetchLike(API_CAPABILITY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: selection.provider, model: selection.model }),
      signal: controller.signal,
    })
    if (!response.ok) return false
    const envelope = (await response.json()) as { ok?: unknown; value?: { supportsImages?: unknown } }
    if (envelope?.ok !== true || envelope.value?.supportsImages !== true) return false
    capabilityCache.set(key, Date.now() + CAPABILITY_TTL_MS)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把图片草稿批量上传到 Host attach 路由并返回 note 文本。
 * @param drafts - 待上传的图片草稿。
 * @param signal - 发送级取消信号。
 * @returns 与草稿同序的 note 文本。
 */
async function uploadImageNotes(drafts: readonly ImageDraft[], signal: AbortSignal | undefined): Promise<string[]> {
  const images = await Promise.all(drafts.map(async (draft) => {
    if (!isImageMimeType(draft.file.type)) {
      throw new Error(`describe-image: 不支持的贴图类型:${draft.file.type}`)
    }
    return {
      mediaType: draft.file.type,
      data: await fileToBase64(draft.file),
      ...(draft.file.name === '' ? {} : { name: draft.file.name }),
    }
  }))
  const response = await fetch(API_ATTACH_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images }),
    signal,
  })
  if (!response.ok) throw new Error(`describe-image: 附件上传失败(HTTP ${response.status})。`)
  const envelope = (await response.json()) as {
    ok?: unknown
    value?: { attachments?: unknown[]; notes?: unknown[] }
    error?: { message?: unknown }
  }
  const refs = envelope?.value?.attachments
  if (envelope?.ok !== true || !Array.isArray(refs) || refs.length !== images.length) {
    const message = typeof envelope?.error?.message === 'string' ? envelope.error.message : '附件入库失败。'
    throw new Error(`describe-image: ${message}`)
  }
  return refs.map((ref) => {
    const attachmentId = nonEmptyString((ref as ImageAttachmentRefLike).attachmentId)
    if (attachmentId === undefined) throw new Error('describe-image: 附件引用无效。')
    return formatAttachmentNote(ref as ImageAttachmentRefLike)
  })
}

/**
 * 把文件读为 base64(无 data-URL 前缀)。优先 `arrayBuffer()` + 分块 `btoa`
 * (浏览器与 Node 都有 `btoa`,单测无需 polyfill);`FileReader` 仅作回退。
 * @param file - 浏览器文件对象。
 * @returns base64 文本。
 */
function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
      }
      return btoa(binary)
    })
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('describe-image: 读取贴图失败。'))
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      const comma = url.indexOf(',')
      if (comma < 0) reject(new Error('describe-image: 贴图编码失败。'))
      else resolve(url.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
