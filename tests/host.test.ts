import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (tool: unknown) => tool,
}))

import { Config, apply, inject, name } from '../src/index'
import { SETTINGS_NAMESPACE, TOOL_NAME, formatAttachmentNote, type ImageAttachmentRefLike } from '../src/core'

/** 最小 PNG 头(仅用于通过 magic-byte 门,不解码)。 */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

/** 一条合法的图片附件引用(note 分支与 attach 路由共用)。 */
const REF: ImageAttachmentRefLike = {
  attachmentId: 'sha256:deadbeef',
  mediaType: 'image/png',
  bytes: PNG_BYTES.byteLength,
  width: 8,
  height: 8,
  name: 'a.png',
}

/** 把普通值包装成 volatile 引用。 */
function volatileRefs(values: Record<string, unknown>): Record<string, { get: () => unknown }> {
  const refs: Record<string, { get: () => unknown }> = {}
  for (const [key, value] of Object.entries(values)) refs[key] = { get: () => value }
  return refs
}

/** 完整的默认设置(未配置端点)。 */
function defaultRefs(overrides: Record<string, unknown> = {}): Record<string, { get: () => unknown }> {
  return volatileRefs({
    baseURL: undefined,
    apiStyle: undefined,
    model: undefined,
    apiKey: undefined,
    apiKeyEnv: undefined,
    defaultPrompt: undefined,
    maxBytes: undefined,
    maxOutputTokens: undefined,
    timeoutMs: undefined,
    interceptImageSend: undefined,
    ...overrides,
  })
}

/** attachment 存储假件;记录 saveImages 收到的输入。 */
function attachStoreFake(refs: readonly ImageAttachmentRefLike[]) {
  const saved: { data: Uint8Array; mediaType: string; name?: string }[] = []
  return {
    saved,
    store: {
      saveImages: async (inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]) => {
        saved.push(...inputs.map((input) => ({ ...input, data: new Uint8Array(input.data) })))
        return refs
      },
      readImage: async () => ({ ref: refs[0] as ImageAttachmentRefLike, data: PNG_BYTES }),
    },
  }
}

/** llm 服务假件。 */
function llmFake(inputModalities: string[] | undefined) {
  return { resolveModelInfo: async () => ({ inputModalities }) }
}

/** apply 的返回面:捕获的工具与注册的路由。 */
interface Harness {
  tool: { name: string; description: string; execute: Function }
  routes: Map<string, (request: Request) => Promise<Response>>
}

/** 以可注入服务假件跑一次 apply,捕获工具与路由。 */
function harness(
  config: unknown,
  services: { attachments?: unknown; llm?: unknown; withConnection?: boolean } = {},
): Harness {
  let captured: { name: string; description: string; execute: Function } | undefined
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const ctx = {
    tools: { register: (tool: never) => { captured = tool } },
    get: (key: string): unknown => {
      if (key === 'attachments') return services.attachments
      if (key === 'llm') return services.llm
      if (key === 'connection' && (services.withConnection ?? true)) {
        return { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route.fetch) } } }
      }
      return undefined
    },
  }
  apply(ctx as never, config as never)
  if (captured === undefined) throw new Error('tool was not registered')
  return { tool: captured, routes }
}

/** 构造 fetch 响应替身。 */
function stubResponse(
  body: string | Uint8Array,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): unknown {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (key: string) => init.headers?.[key.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

const exec = { signal: new AbortController().signal }

describe('Host 入口与 manifest 契约', () => {
  it('声明 tools/connection 依赖,并以 profile entry id 作为设置命名空间', () => {
    expect(name).toBe('dsh-describe-image')
    expect(inject).toEqual(['tools', 'connection'])
    expect(SETTINGS_NAMESPACE).toBe('dsh-describe-image')
  })

  it('Config 的每个字段都是 volatile,保证 SettingsForms 收集该命名空间', () => {
    const schema = Config as unknown as { meta?: { volatile?: boolean }; dict?: Record<string, { meta?: { volatile?: boolean } }> }
    const fields = Object.keys(schema.dict ?? {})
    expect(fields.sort()).toEqual([
      'apiKey',
      'apiKeyEnv',
      'apiStyle',
      'baseURL',
      'defaultPrompt',
      'interceptImageSend',
      'maxBytes',
      'maxOutputTokens',
      'model',
      'renderImagePreview',
      'timeoutMs',
    ])
    for (const field of fields) {
      expect(schema.dict?.[field]?.meta?.volatile, `${field} 必须是 volatile`).toBe(true)
    }
  })

  it('注册 describe_image 工具,并声明 image/prompt 参数', () => {
    const { tool } = harness(defaultRefs())
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.description).toContain('image')
  })
})

describe('未配置端点时的错误', () => {
  it('缺少 baseURL 时给出可操作错误', async () => {
    const { tool } = harness(defaultRefs())
    await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/baseURL|接口地址/)
  })

  it('缺少 model 时给出可操作错误', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'https://vision.example/v1' }))
    await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/model|模型/)
  })

  it('非 http(s) baseURL 被拒绝', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'ftp://vision.example', model: 'm' }))
    await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/http\(s\)/)
  })
})

describe('图片加载边界', () => {
  it('拒绝非 http(s) 协议', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
    await expect(tool.execute({ image: 'file:///etc/passwd' }, exec)).rejects.toThrow(/http\(s\)/)
  })

  it('拒绝非工作区绝对路径', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
    await expect(tool.execute({ image: 'relative/path.png' }, exec)).rejects.toThrow(/绝对路径/)
  })

  it('没有会话工作区时拒绝本地路径', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
    await expect(tool.execute({ image: '/tmp/anything.png' }, exec)).rejects.toThrow(/工作区/)
  })

  it('magic bytes 不匹配时拒绝', async () => {
    const fetchMock = vi.fn(async () => stubResponse('not an image at all'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
      await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/不支持的图片类型/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超过字节上限时拒绝', async () => {
    const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm', maxBytes: 4 }))
    const fetchMock = vi.fn(async () => stubResponse(PNG_BYTES))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/上限/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('视觉请求链路', () => {
  it('下载图片并调用 chat-completions,只返回文本', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), ...(init?.body === undefined ? {} : { body: init.body }) })
      if (String(url).includes('example.com')) return stubResponse(PNG_BYTES)
      return stubResponse(JSON.stringify({ choices: [{ message: { content: '一张测试图' } }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { tool } = harness(defaultRefs({
        baseURL: 'https://v.example/v1/',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
      }))
      const result = await tool.execute({ image: 'https://example.com/a.png', prompt: '转录文字' }, exec)

      expect(result.text).toBe('一张测试图')
      expect(result.model).toBe('gpt-4o-mini')
      expect(result.mimeType).toBe('image/png')
      expect(result.bytes).toBe(PNG_BYTES.byteLength)
      expect(calls[0]?.url).toBe('https://example.com/a.png')
      // 末尾斜杠被规范化,协议路径被追加
      expect(calls[1]?.url).toBe('https://v.example/v1/chat/completions')
      const body = JSON.parse(calls[1]?.body ?? '{}')
      expect(body.model).toBe('gpt-4o-mini')
      expect(body.max_tokens).toBe(1024)
      expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('每次调用都重新读取 volatile 设置', async () => {
    const models: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('example.com')) return stubResponse(PNG_BYTES)
      models.push(JSON.parse(init?.body ?? '{}').model)
      return stubResponse(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      let currentModel = 'first-model'
      const refs = defaultRefs({ baseURL: 'https://v.example/v1', model: 'first-model' })
      refs.model = { get: () => currentModel }
      const { tool } = harness(refs)

      await tool.execute({ image: 'https://example.com/a.png' }, exec)
      currentModel = 'second-model'
      await tool.execute({ image: 'https://example.com/a.png' }, exec)

      expect(models).toEqual(['first-model', 'second-model'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Anthropic 协议使用 x-api-key 与 /v1/messages', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = []
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes('example.com')) return stubResponse(PNG_BYTES)
      calls.push({ url: String(url), headers: init?.headers })
      return stubResponse(JSON.stringify({ content: [{ type: 'text', text: 'claude 视角' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { tool } = harness(defaultRefs({
        baseURL: 'https://api.anthropic.example',
        model: 'claude-vision',
        apiStyle: 'anthropic-messages',
        apiKey: 'key-123',
      }))
      const result = await tool.execute({ image: 'https://example.com/a.png' }, exec)
      expect(result.text).toBe('claude 视角')
      expect(calls[0]?.url).toBe('https://api.anthropic.example/v1/messages')
      expect(calls[0]?.headers?.['x-api-key']).toBe('key-123')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('端点非 2xx 时给出有界错误', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('example.com')) return stubResponse(PNG_BYTES)
      return stubResponse('boom', { ok: false, status: 502 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { tool } = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
      await expect(tool.execute({ image: 'https://example.com/a.png' }, exec)).rejects.toThrow(/HTTP 502/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
describe('note 分支:贴图引用直达工具', () => {
  const NOTE = formatAttachmentNote(REF)

  it('模型回传 note 时从附件存储取字节并调视觉端点', async () => {
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? '')
      return stubResponse(JSON.stringify({ choices: [{ message: { content: '附件里的图' } }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { store } = attachStoreFake([REF])
      const h = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }), { attachments: store })
      const result = await h.tool.execute({ image: NOTE, prompt: '看图' }, exec)
      expect(result.text).toBe('附件里的图')
      expect(result.mimeType).toBe('image/png')
      // 不应有图片下载 fetch:第一个请求就是视觉端点。
      expect(JSON.parse(bodies[0] ?? '{}').messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('附件服务缺失时给出可操作错误', async () => {
    const h = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }), { attachments: undefined })
    await expect(h.tool.execute({ image: NOTE }, exec)).rejects.toThrow(/附件服务不可用/)
  })

  it('无法解析的 [ 开头输入被拒绝并提示原样回传', async () => {
    const h = harness(defaultRefs({ baseURL: 'https://v.example/v1', model: 'm' }))
    await expect(h.tool.execute({ image: '[image attachment not-json' }, exec)).rejects.toThrow(/原样回传/)
  })

  it('无 connection 的部署仍然注册工具(headless 兼容)', () => {
    const h = harness(defaultRefs(), { withConnection: false })
    expect(h.tool.name).toBe(TOOL_NAME)
    expect(h.routes.size).toBe(0)
  })
})

describe('attach 路由', () => {
  const ATTACH = '/api/dsh-describe-image/attach'

  function post(route: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
    return route(new Request('http://x' + ATTACH, { method: 'POST', body: JSON.stringify(body) }))
  }

  it('把 base64 解码后写入附件存储并返回 note', async () => {
    const fake = attachStoreFake([REF])
    const h = harness(defaultRefs(), { attachments: fake.store })
    const route = h.routes.get(ATTACH)
    expect(route).toBeDefined()
    const response = await post(route as never, { images: [{ mediaType: 'image/png', data: Buffer.from(PNG_BYTES).toString('base64'), name: 'a.png' }] })
    expect(response.status).toBe(200)
    const envelope = await response.json() as { ok: boolean; value?: { attachments?: unknown[]; notes?: string[] } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value?.attachments?.length).toBe(1)
    expect(envelope.value?.notes?.[0]).toBe(formatAttachmentNote(REF))
    expect(Array.from(fake.saved[0]?.data ?? [])).toEqual(Array.from(PNG_BYTES))
    expect(fake.saved[0]?.mediaType).toBe('image/png')
  })

  it('坏 JSON 返回 400', async () => {
    const h = harness(defaultRefs(), { attachments: attachStoreFake([REF]).store })
    const route = h.routes.get(ATTACH) as never
    const response = await route(new Request('http://x' + ATTACH, { method: 'POST', body: '{oops' }))
    expect(response.status).toBe(400)
  })

  it('附件服务缺失时返回 ok:false', async () => {
    const h = harness(defaultRefs(), { attachments: undefined })
    const response = await post(h.routes.get(ATTACH) as never, { images: [{ mediaType: 'image/png', data: 'AAAA' }] })
    const envelope = await response.json() as { ok: boolean; error?: { message?: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.message).toContain('附件存储服务不可用')
  })

  it('saveImages 抛错时返回有界错误', async () => {
    const failing = {
      saveImages: async () => { throw new Error('像素超限。'.repeat(50)) },
      readImage: async () => { throw new Error('unused') },
    }
    const h = harness(defaultRefs(), { attachments: failing })
    const response = await post(h.routes.get(ATTACH) as never, { images: [{ mediaType: 'image/png', data: 'AAAA' }] })
    const envelope = await response.json() as { ok: boolean; error?: { message?: string } }
    expect(envelope.ok).toBe(false)
    expect((envelope.error?.message ?? '').length).toBeLessThanOrEqual(200 + 'describe-image: 图片入库失败:'.length)
  })

  it('超出 base64 总量上限的请求返回 400', async () => {
    const h = harness(defaultRefs(), { attachments: attachStoreFake([REF]).store })
    const big = 'A'.repeat(65 * 1024 * 1024)
    const response = await post(h.routes.get(ATTACH) as never, { images: [{ mediaType: 'image/png', data: big }] })
    expect(response.status).toBe(400)
  })
})

describe('capability 路由', () => {
  const CAPABILITY = '/api/dsh-describe-image/capability'

  function post(route: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
    return route(new Request('http://x' + CAPABILITY, { method: 'POST', body: JSON.stringify(body) }))
  }

  it('inputModalities 含 image 时返回 supportsImages:true', async () => {
    const h = harness(defaultRefs(), { llm: llmFake(['text', 'image']) })
    const response = await post(h.routes.get(CAPABILITY) as never, { provider: 'fengwind', model: 'deepseek-v4-vision' })
    const envelope = await response.json() as { ok: boolean; value?: { supportsImages?: boolean } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value?.supportsImages).toBe(true)
  })

  it('inputModalities 不含 image 时返回 false', async () => {
    const h = harness(defaultRefs(), { llm: llmFake(['text']) })
    const response = await post(h.routes.get(CAPABILITY) as never, { provider: 'fengwind', model: 'deepseek-v4-flash' })
    const envelope = await response.json() as { ok: boolean; value?: { supportsImages?: boolean } }
    expect(envelope.value?.supportsImages).toBe(false)
  })

  it('缺 provider 或 model 返回 400', async () => {
    const h = harness(defaultRefs(), { llm: llmFake(undefined) })
    const response = await post(h.routes.get(CAPABILITY) as never, { model: 'm' })
    expect(response.status).toBe(400)
  })

  it('resolveModelInfo 抛错或服务缺失时返回 ok:false', async () => {
    const failing = { resolveModelInfo: async () => { throw new Error('nope') } }
    const h1 = harness(defaultRefs(), { llm: failing })
    const r1 = await post(h1.routes.get(CAPABILITY) as never, { provider: 'p', model: 'm' })
    expect((await r1.json() as { ok: boolean }).ok).toBe(false)
    const h2 = harness(defaultRefs(), { llm: undefined })
    const r2 = await post(h2.routes.get(CAPABILITY) as never, { provider: 'p', model: 'm' })
    expect((await r2.json() as { ok: boolean }).ok).toBe(false)
  })
})

describe('raw 路由', () => {
  const RAW = '/api/dsh-describe-image/raw'

  it('按引用返回存储字节并带内容寻址缓存头', async () => {
    const { store } = attachStoreFake([REF])
    const h = harness(defaultRefs(), { attachments: store })
    const route = h.routes.get(RAW) as never
    const response = await route(new Request(`http://x${RAW}?ref=${encodeURIComponent(JSON.stringify(REF))}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(response.headers.get('etag')).toContain(REF.attachmentId)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(Array.from(body)).toEqual(Array.from(PNG_BYTES))
  })

  it('缺 ref 或坏 JSON 返回 400;存储缺失返回 503', async () => {
    const { store } = attachStoreFake([REF])
    const h = harness(defaultRefs(), { attachments: store })
    const route = h.routes.get(RAW) as never
    const missing = await route(new Request(`http://x${RAW}`))
    expect(missing.status).toBe(400)
    const bad = await route(new Request(`http://x${RAW}?ref=%7Boops`))
    expect(bad.status).toBe(400)
    const h2 = harness(defaultRefs(), { attachments: undefined })
    const unavailable = await (h2.routes.get(RAW) as never)(new Request(`http://x${RAW}?ref=${encodeURIComponent(JSON.stringify(REF))}`))
    expect(unavailable.status).toBe(503)
  })
})
