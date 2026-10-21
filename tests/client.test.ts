import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/client/index'
import { sectionStatus } from '../src/client/settings'
import { SETTINGS_NAMESPACE } from '../src/core'

/** 构造一个最小的 configForms 控制器替身。 */
function fakeScope(status: 'loading' | 'ready' | 'unavailable') {
  return {
    getSnapshot: () => ({ status, value: {}, writable: status === 'ready' }),
    subscribe: () => () => undefined,
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
}

/** 捕获 settings.section 的注册参数。 */
function captureRegistration(status: 'loading' | 'ready' | 'unavailable' = 'ready') {
  const scope = fakeScope(status)
  const get = vi.fn(() => scope)
  let captured: { options: Record<string, unknown>; component: unknown } | undefined
  let injectedSlot: string | undefined

  const slots = {
    inject: (key: string, factory: () => unknown) => {
      injectedSlot = key
      factory()
      return () => undefined
    },
    register: (options: Record<string, unknown>, component: unknown) => {
      captured = { options, component }
      return () => undefined
    },
  }

  apply({ slots, configForms: { get } } as never)
  if (captured === undefined) throw new Error('settings.section was not registered')
  return { get, captured, injectedSlot }
}

describe('Client 设置卡注册', () => {
  it('声明 slots、configForms 与 conversation 依赖', () => {
    expect(name).toBe('dsh-describe-image-client')
    expect(inject).toEqual(['slots', 'configForms', 'conversation'])
  })

  it('用 profile entry id 作为命名空间读取 configForms', () => {
    const { get } = captureRegistration()
    expect(get).toHaveBeenCalledWith(SETTINGS_NAMESPACE)
    expect(SETTINGS_NAMESPACE).toBe('dsh-describe-image')
  })

  it('注册到 settings.section,注入返回 props 的工厂函数', () => {
    const { captured, injectedSlot } = captureRegistration()
    expect(injectedSlot).toBe('settings.section')
    expect(captured.options.name).toBe('settings.section')
    expect(captured.options.id).toBe(SETTINGS_NAMESPACE)
    expect(captured.options.label).toBe('图像理解')
    expect(typeof captured.options.order).toBe('number')
    // inject 必须是返回对象 props 的函数;写成对象字面量会静默失效。
    expect(typeof captured.options.inject).toBe('function')
    expect(Object.keys(captured.options.inject() as Record<string, unknown>)).toEqual(['scope'])
  })
})

describe('设置卡状态判定', () => {
  it('区分 loading / unavailable / ready', () => {
    expect(sectionStatus({ status: 'loading' })).toBe('loading')
    expect(sectionStatus({ status: 'unavailable' })).toBe('unavailable')
    expect(sectionStatus({ status: 'ready' })).toBe('ready')
  })

  it('未知状态保守地视为 ready', () => {
    expect(sectionStatus({ status: 'something-else' })).toBe('ready')
  })
})
import { installSendHook, readModelSelection, queryCapabilitySupportsImages } from '../src/client/send-hook'
import { formatAttachmentNote, type ImageAttachmentRefLike } from '../src/core'

const REF: ImageAttachmentRefLike = {
  attachmentId: 'sha256:abc',
  mediaType: 'image/png',
  bytes: 12,
  width: 8,
  height: 8,
  name: 'a.png',
}
const NOTE = formatAttachmentNote(REF)
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/** conversation 服务假件。 */
function makeConversation(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ text: string; ids: string[] }> = []
  const released: unknown[][] = []
  const base = {
    sendSession: async (_session: unknown, text: string, ids: readonly string[]) => {
      sent.push({ text, ids: [...ids] })
      return { kind: 'success' as const }
    },
    resolveDraftAttachments: (ids: readonly string[]) =>
      ids.map((id) => ({ id, kind: 'image' as const, file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) })),
    releaseDraftAttachments: (attachments: unknown[]) => { released.push(attachments) },
    ...overrides,
  }
  return { face: base, sent, released }
}

/** 按 URL 分流 stub fetch:capability 与 attach。 */
function stubHostFetch(
  capability: { ok: boolean; value?: { supportsImages?: boolean } },
  attach: { ok: boolean; value?: { attachments?: unknown[] } } | 'fail',
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.includes('/capability')) return new Response(JSON.stringify(capability), { status: 200 })
    if (attach === 'fail') return new Response(JSON.stringify({ ok: false, error: { message: 'boom' } }), { status: 200 })
    return new Response(JSON.stringify(attach), { status: 200 })
  })
}

/** modelSelection 投影可读的 session 假件。 */
function sessionWithModel(provider = 'fengwind', model = 'deepseek-v4-flash'): unknown {
  return {
    sessionId: 's1',
    projections: { faceOf: (key: string) => key === 'modelSelection'
      ? { getSnapshot: () => ({ next: { provider, model } }) }
      : undefined },
  }
}

describe('installSendHook', () => {
  it('无图片草稿时原样透传,零网络请求', async () => {
    const fetchMock = stubHostFetch({ ok: true, value: { supportsImages: false } }, 'fail')
    vi.stubGlobal('fetch', fetchMock)
    try {
      const conv = makeConversation({ resolveDraftAttachments: () => [] })
      installSendHook({}, conv.face, undefined)
      const outcome = await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel(), '你好', ['f1'], 'queue')
      expect(outcome.kind).toBe('success')
      expect(conv.sent[0]?.text).toBe('你好')
      expect(conv.sent[0]?.ids).toEqual(['f1'])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('纯文本模型:上传改写为 note,保留文件草稿,成功后释放图片草稿', async () => {
    const fetchMock = stubHostFetch({ ok: true, value: { supportsImages: false } }, { ok: true, value: { attachments: [REF] } })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const conv = makeConversation({ resolveDraftAttachments: (ids: readonly string[]) => ids.map((id) => id === 'img1'
        ? { id, kind: 'image', file: new File([PNG_BYTES], 'a.png', { type: 'image/png' }) }
        : { id, kind: 'file', file: new File([PNG_BYTES], 'b.txt', { type: 'text/plain' }) }) })
      installSendHook({}, conv.face, undefined)
      const outcome = await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel(), '看图', ['img1', 'f1'], 'queue')
      expect(outcome.kind).toBe('success')
      expect(conv.sent[0]?.text).toBe(`看图\n${NOTE}`)
      expect(conv.sent[0]?.ids).toEqual(['f1'])
      expect(conv.released.length).toBe(1)
      const attachCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/attach'))
      const body = JSON.parse((attachCall?.[1] as { body: string })?.body ?? '{}')
      expect(body.images[0].mediaType).toBe('image/png')
      expect(body.images[0].data).toBe(Buffer.from(PNG_BYTES).toString('base64'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('发送失败时不释放图片草稿(composer 需要恢复)', async () => {
    vi.stubGlobal('fetch', stubHostFetch({ ok: true, value: { supportsImages: false } }, { ok: true, value: { attachments: [REF] } }))
    try {
      const conv = makeConversation({ sendSession: async () => ({ kind: 'error' as const }) })
      installSendHook({}, conv.face, undefined)
      await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel(), '', ['img1'], 'queue')
      expect(conv.released.length).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('attach 失败时回落原样发送', async () => {
    const fetchMock = stubHostFetch({ ok: true, value: { supportsImages: false } }, 'fail')
    vi.stubGlobal('fetch', fetchMock)
    try {
      const conv = makeConversation()
      installSendHook({}, conv.face, undefined)
      const outcome = await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel(), '看图', ['img1'], 'queue')
      expect(outcome.kind).toBe('success')
      expect(conv.sent[0]?.text).toBe('看图')
      expect(conv.sent[0]?.ids).toEqual(['img1'])
      expect(conv.released.length).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('视觉模型直通且不改写(capability 命中)', async () => {
    const fetchMock = stubHostFetch({ ok: true, value: { supportsImages: true } }, 'fail')
    vi.stubGlobal('fetch', fetchMock)
    try {
      const conv = makeConversation()
      installSendHook({}, conv.face, undefined)
      await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel('fengwind', 'deepseek-v4-vision'), '看图', ['img1'], 'queue')
      expect(conv.sent[0]?.ids).toEqual(['img1'])
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/attach'))).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('interceptImageSend === false 时透通', async () => {
    vi.stubGlobal('fetch', stubHostFetch({ ok: true, value: { supportsImages: false } }, 'fail'))
    try {
      const conv = makeConversation()
      installSendHook({}, conv.face, { getSnapshot: () => ({ value: { interceptImageSend: false } }) })
      await (conv.face as never as { sendSession: Function }).sendSession(sessionWithModel(), '看图', ['img1'], 'queue')
      expect(conv.sent[0]?.ids).toEqual(['img1'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('服务面缺失时静默不装,重复安装幂等', () => {
    const broken = { sendSession: async () => ({ kind: 'success' as const }) }
    expect(() => installSendHook({}, broken, undefined)).not.toThrow()
    const conv = makeConversation()
    installSendHook({}, conv.face, undefined)
    const first = (conv.face as never as { sendSession: Function }).sendSession
    installSendHook({}, conv.face, undefined)
    expect((conv.face as never as { sendSession: Function }).sendSession).toBe(first)
  })

  it('readModelSelection:next 为 null 或结构缺失时返回 undefined(按纯文本处理)', () => {
    expect(readModelSelection({ projections: { faceOf: (k: string) => k === 'modelSelection' ? { getSnapshot: () => ({ next: null }) } : undefined } })).toBeUndefined()
    expect(readModelSelection({ sessionId: 's1' })).toBeUndefined()
    expect(readModelSelection(undefined)).toBeUndefined()
  })
})

describe('queryCapabilitySupportsImages', () => {
  it('失败不缓存,成功缓存(同 key 二次不请求)', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      return new Response(JSON.stringify({ ok: true, value: { supportsImages: true } }), { status: 200 })
    })
    const selection = { provider: 'p', model: `m-${Math.random()}` }
    expect(await queryCapabilitySupportsImages(selection, fetchMock as never)).toBe(true)
    expect(await queryCapabilitySupportsImages(selection, fetchMock as never)).toBe(true)
    expect(calls).toBe(1)
    const failing = vi.fn(async () => new Response('bad', { status: 500 }))
    expect(await queryCapabilitySupportsImages({ provider: selection.provider, model: 'other' }, failing as never)).toBe(false)
  })
})
