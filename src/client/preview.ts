/**
 * dsh-describe-image — 会话内图片预览(Client 半区)。
 *
 * Web shell 把用户消息渲染为纯文本,发送改写拼进去的 `[image attachment {...}]`
 * 引用因此在聊天记录里以原始 JSON 形态示人。本模块观察会话容器
 * (`[data-slot="main.conversation"]`),把每条引用原地升级为缩略图
 * (`<img>` 指向 Host raw 路由),点击弹出全屏大图(Esc/点击关闭)。
 *
 * 只改浏览器 DOM:消息文本、会话记录、模型侧完全不动;开关关闭或插件卸载时
 * 原文本还原。扫描是增量且幂等的——MutationObserver 只处理每条变更记录携带
 * 的节点,已处理的引用是元素而非文本节点,重扫不会再命中。图片加载失败时
 * 该引用还原为文本并按会话记住失败路径,不再反复尝试。
 *
 * @module dsh-describe-image/client/preview
 */

import { buildRawImageURL, findAttachmentNotes, type ImageAttachmentRefLike } from '../core'

/** 会话主容器的官方槽标记(composer 是独立槽,不在此容器语义内,仍显式排除)。 */
const CONVERSATION_ROOT_SELECTOR = '[data-slot="main.conversation"]'
/** 注入元素的标记;值为被替换的原始 note 文本,还原时使用。 */
const PREVIEW_ATTR = 'data-dsh-di-preview'
/** 大图层标记。 */
const LIGHTBOX_ATTR = 'data-dsh-di-lightbox'
/** 缩略图长边上限(像素)。 */
const THUMBNAIL_MAX_EDGE = 240
/** 会话级失败路径记忆上限。 */
const MAX_FAILED_IDS = 200

/** 预览句柄。 */
export interface ConversationImagePreview {
  /** 立即重扫(设置保存后调用);开关关闭时还原全部预览。 */
  refresh(): void
  /** 还原全部预览、关闭大图并停止观察。 */
  dispose(): void
}

/**
 * 安装会话预览增强。无 DOM 环境(测试/headless)返回 no-op 句柄。
 * @param isEnabled - 每次扫描前读取;仅 `false` 视为关闭。
 * @returns 预览句柄。
 */
export function installConversationImagePreview(isEnabled: () => boolean): ConversationImagePreview {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
    return { refresh(): void {}, dispose(): void {} }
  }
  /** 图片加载失败的引用 id(会话级记忆)。 */
  const failedIds = new Set<string>()
  let lightbox: HTMLElement | undefined
  let contentObserver: MutationObserver | undefined
  let observedRoot: HTMLElement | undefined
  /** document 级观察者:会话切换时容器会重建,需要重新发现。 */
  let mountObserver: MutationObserver | undefined
  let disposed = false
  /** 微任务合并标记,避免一次 DOM 批量变更触发多轮扫描。 */
  let scheduled = false

  const isPreviewEnabled = (): boolean => isEnabled() !== false

  /** 文本节点是否落在不可替换的表面(输入区、裸文本岛、自己注入的 UI)。 */
  const isExcluded = (node: Text): boolean => {
    const parent = node.parentElement
    if (parent === null) return true
    return parent.closest(
      `input, textarea, script, style, noscript, [contenteditable], [data-slot^="conversation.composer"], [${PREVIEW_ATTR}], [${LIGHTBOX_ATTR}]`,
    ) !== null
  }

  /** 把一个文本节点里的全部引用替换为缩略图;已知失败的引用保持文本。 */
  const upgradeTextNode = (node: Text): void => {
    if (isExcluded(node)) return
    const text = node.data
    if (!text.includes('[image attachment')) return
    const matches = findAttachmentNotes(text).filter((match) => !failedIds.has(match.ref.attachmentId))
    if (matches.length === 0) return
    const parent = node.parentElement
    if (parent === null) return
    const fragments: Array<Node> = []
    let cursor = 0
    for (const match of matches) {
      if (match.start > cursor) fragments.push(document.createTextNode(text.slice(cursor, match.start)))
      fragments.push(createThumbnail(match.ref, text.slice(match.start, match.end)))
      cursor = match.end
    }
    if (cursor < text.length) fragments.push(document.createTextNode(text.slice(cursor)))
    const holder = document.createDocumentFragment()
    for (const fragment of fragments) holder.appendChild(fragment)
    parent.replaceChild(holder, node)
  }

  /** 构造一个缩略图按钮;加载失败时还原为原始文本。 */
  const createThumbnail = (ref: ImageAttachmentRefLike, source: string): HTMLElement => {
    const button = document.createElement('button')
    button.setAttribute(PREVIEW_ATTR, source)
    button.type = 'button'
    button.title = '查看原图'
    Object.assign(button.style, {
      display: 'inline-block',
      padding: '0',
      margin: '2px 0',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-module-platform, rgba(0,0,0,.04))',
      cursor: 'pointer',
      lineHeight: '0',
      overflow: 'hidden',
      verticalAlign: 'bottom',
    } satisfies Partial<CSSStyleDeclaration>)
    const img = document.createElement('img')
    Object.assign(img.style, {
      display: 'block',
      maxWidth: `${THUMBNAIL_MAX_EDGE}px`,
      maxHeight: `${THUMBNAIL_MAX_EDGE}px`,
      width: 'auto',
      height: 'auto',
    } satisfies Partial<CSSStyleDeclaration>)
    img.alt = '会话图片'
    img.decoding = 'async'
    img.src = buildRawImageURL(ref)
    img.onerror = (): void => {
      if (failedIds.size >= MAX_FAILED_IDS) {
        const oldest = failedIds.values().next()
        if (oldest.done !== true) failedIds.delete(oldest.value)
      }
      failedIds.add(ref.attachmentId)
      button.replaceWith(document.createTextNode(source))
    }
    button.appendChild(img)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      openLightbox(ref)
    })
    return button
  }

  /** 打开全屏大图;Esc 或点击任意处关闭。 */
  const openLightbox = (ref: ImageAttachmentRefLike): void => {
    closeLightbox()
    const overlay = document.createElement('div')
    overlay.setAttribute(LIGHTBOX_ATTR, '')
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'rgba(0,0,0,.72)',
      cursor: 'zoom-out',
    } satisfies Partial<CSSStyleDeclaration>)
    const img = document.createElement('img')
    Object.assign(img.style, {
      maxWidth: '100%',
      maxHeight: '100%',
      borderRadius: '8px',
      boxShadow: '0 12px 40px rgba(0,0,0,.4)',
    } satisfies Partial<CSSStyleDeclaration>)
    img.alt = '原图'
    img.src = buildRawImageURL(ref)
    overlay.appendChild(img)
    overlay.addEventListener('click', closeLightbox)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeLightbox()
    }
    document.addEventListener('keydown', onKey, { once: false })
    ;(overlay as HTMLElement & { __onKey?: (event: KeyboardEvent) => void }).__onKey = onKey
    document.body.appendChild(overlay)
    lightbox = overlay
  }

  /** 关闭大图。 */
  const closeLightbox = (): void => {
    if (lightbox === undefined) return
    const onKey = (lightbox as HTMLElement & { __onKey?: (event: KeyboardEvent) => void }).__onKey
    if (onKey !== undefined) document.removeEventListener('keydown', onKey)
    lightbox.remove()
    lightbox = undefined
  }

  /** 扫描一棵子树里的全部文本节点。 */
  const scanTree = (root: Node): void => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      upgradeTextNode(node as Text)
    }
  }

  /** 合并到微任务的扫描入口。 */
  const scheduleScan = (targets?: Node[]): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) return
      if (!isPreviewEnabled()) return
      if (targets === undefined) {
        const root = observedRoot ?? document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR) ?? undefined
        if (root !== undefined) scanTree(root)
        return
      }
      for (const target of targets) scanTree(target)
    })
  }

  /** 把内容观察者挂到一个(重新)发现的会话容器上。 */
  const observeRoot = (root: HTMLElement): void => {
    if (observedRoot === root) return
    contentObserver?.disconnect()
    observedRoot = root
    contentObserver = new MutationObserver((records) => {
      const targets: Node[] = []
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) upgradeTextNode(node as Text)
          else targets.push(node)
        }
      }
      if (targets.length > 0) scheduleScan(targets)
    })
    contentObserver.observe(root, { childList: true, subtree: true })
    scheduleScan()
  }

  /** document 级:发现/重新发现会话容器(会话切换会重挂)。 */
  const discoverRoot = (): void => {
    if (disposed) return
    const root = document.querySelector<HTMLElement>(CONVERSATION_ROOT_SELECTOR)
    if (root !== null) observeRoot(root)
  }

  mountObserver = new MutationObserver(discoverRoot)
  mountObserver.observe(document.body, { childList: true, subtree: true })
  discoverRoot()

  return {
    refresh(): void {
      if (disposed) return
      if (!isPreviewEnabled()) {
        closeLightbox()
        restoreAll()
        return
      }
      scheduleScan()
    },
    dispose(): void {
      disposed = true
      closeLightbox()
      restoreAll()
      contentObserver?.disconnect()
      mountObserver?.disconnect()
      contentObserver = undefined
      mountObserver = undefined
      observedRoot = undefined
    },
  }

  /** 还原 scope 内全部预览为原始文本。 */
  function restoreAll(): void {
    const scope = observedRoot ?? document
    for (const preview of [...scope.querySelectorAll(`[${PREVIEW_ATTR}]`)]) {
      const source = preview.getAttribute(PREVIEW_ATTR)
      if (source !== null) preview.replaceWith(document.createTextNode(source))
    }
  }
}
