import { describe, expect, it } from 'vitest'
import {
  API_STYLES,
  IMAGE_MEDIA_TYPES,
  asApiStyle,
  endpointURL,
  isImageMimeType,
  nonEmptyString,
  normalizeBaseURL,
  positiveNumber,
  sniffMimeType,
} from '../src/core'

/** 在给定字节前补零,便于构造最小头。 */
function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

describe('sniffMimeType', () => {
  it('识别 PNG / JPEG / GIF / WebP', () => {
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffMimeType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(sniffMimeType(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBe('image/gif')
    expect(
      sniffMimeType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    ).toBe('image/webp')
  })

  it('拒绝未知或截断输入', () => {
    expect(sniffMimeType(bytes())).toBeUndefined()
    expect(sniffMimeType(bytes(0x89, 0x50))).toBeUndefined()
    expect(sniffMimeType(bytes(0x3c, 0x73, 0x76, 0x67))).toBeUndefined()
  })

  it('isImageMimeType 与列表一致', () => {
    for (const mime of IMAGE_MEDIA_TYPES) expect(isImageMimeType(mime)).toBe(true)
    expect(isImageMimeType('image/svg+xml')).toBe(false)
    expect(isImageMimeType(undefined)).toBe(false)
  })
})

describe('endpointURL', () => {
  it('按协议追加路径并规范化末尾斜杠', () => {
    expect(endpointURL('https://v.example/v1/', 'chat-completions')).toBe('https://v.example/v1/chat/completions')
    expect(endpointURL('https://v.example/v1', 'responses')).toBe('https://v.example/v1/responses')
    expect(endpointURL('https://v.example', 'anthropic-messages')).toBe('https://v.example/v1/messages')
    expect(endpointURL('https://v.example/v1', 'anthropic-messages')).toBe('https://v.example/v1/messages')
  })

  it('normalizeBaseURL 处理空白与斜杠', () => {
    expect(normalizeBaseURL('  https://v.example/v1///  ')).toBe('https://v.example/v1')
  })
})

describe('输入收敛', () => {
  it('positiveNumber 只接受正有限数', () => {
    expect(positiveNumber(5, 1)).toBe(5)
    expect(positiveNumber(0, 1)).toBe(1)
    expect(positiveNumber(-3, 1)).toBe(1)
    expect(positiveNumber(Number.NaN, 1)).toBe(1)
    expect(positiveNumber('9', 1)).toBe(1)
    expect(positiveNumber(undefined, 7)).toBe(7)
  })

  it('nonEmptyString 去掉空白', () => {
    expect(nonEmptyString('  x ')).toBe('x')
    expect(nonEmptyString('   ')).toBeUndefined()
    expect(nonEmptyString(42)).toBeUndefined()
  })

  it('asApiStyle 只接受已知协议', () => {
    for (const style of API_STYLES) expect(asApiStyle(style)).toBe(style)
    expect(asApiStyle('grpc')).toBe('chat-completions')
    expect(asApiStyle(undefined)).toBe('chat-completions')
  })
})
import {
  ATTACHMENT_NOTE_PREFIX,
  formatAttachmentNote,
  isInterceptEnabled,
  parseAttachmentNote,
  type ImageAttachmentRefLike,
} from '../src/core'

describe('attachment note 编解码', () => {
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'sha256:abc',
    mediaType: 'image/webp',
    bytes: 128,
    width: 64,
    height: 32,
    name: 'shot.webp',
  }

  it('format 与 parse 往返无损(含可选字段)', () => {
    const note = formatAttachmentNote(ref)
    expect(note.startsWith('[image attachment {')).toBe(true)
    expect(note.endsWith(']')).toBe(true)
    expect(parseAttachmentNote(note)).toEqual(ref)
  })

  it('parse 容忍首尾空白', () => {
    expect(parseAttachmentNote(`  \n${formatAttachmentNote(ref)}\t`)).toEqual(ref)
  })

  it('拒绝坏 JSON、缺字段、错媒体类型与非正尺寸', () => {
    expect(parseAttachmentNote('[image attachment not-json]')).toBeUndefined()
    expect(parseAttachmentNote(`[image attachment ${JSON.stringify({ mediaType: 'image/png', bytes: 1, width: 1, height: 1 })}]`)).toBeUndefined()
    expect(parseAttachmentNote(`[image attachment ${JSON.stringify({ attachmentId: 'x', mediaType: 'image/svg+xml', bytes: 1, width: 1, height: 1 })}]`)).toBeUndefined()
    expect(parseAttachmentNote(`[image attachment ${JSON.stringify({ attachmentId: 'x', mediaType: 'image/png', bytes: 0, width: 1, height: 1 })}]`)).toBeUndefined()
    expect(parseAttachmentNote(`[image attachment ${JSON.stringify({ attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1.5, height: 1 })}]`)).toBeUndefined()
  })

  it('普通 URL 与路径不受影响', () => {
    expect(parseAttachmentNote('https://example.com/a.png')).toBeUndefined()
    expect(parseAttachmentNote('/tmp/a.png')).toBeUndefined()
    expect(parseAttachmentNote('[image attachment')).toBeUndefined()
  })

  it('originalDimensions 非法时整体丢弃,其余字段保留', () => {
    const note = `[image attachment ${JSON.stringify({ ...ref, originalDimensions: { width: -1, height: 2 } })}]`
    const parsed = parseAttachmentNote(note)
    expect(parsed).toEqual(ref)
  })

  it('ATTACHMENT_NOTE_PREFIX 与序列化形态一致', () => {
    expect(formatAttachmentNote(ref).startsWith(ATTACHMENT_NOTE_PREFIX)).toBe(true)
  })
})

describe('isInterceptEnabled', () => {
  it('仅显式 false 关闭,其余(含缺省)开启', () => {
    expect(isInterceptEnabled(false)).toBe(false)
    expect(isInterceptEnabled(undefined)).toBe(true)
    expect(isInterceptEnabled(true)).toBe(true)
    expect(isInterceptEnabled('x')).toBe(true)
  })
})

import {
  API_RAW_PATH,
  buildRawImageURL,
  findAttachmentNotes,
  parseAttachmentRefJSON,
} from '../src/core'

describe('findAttachmentNotes 定位器', () => {
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'sha256:abc',
    mediaType: 'image/webp',
    bytes: 128,
    width: 64,
    height: 32,
    name: 'shot.webp',
  }
  const note = formatAttachmentNote(ref)

  it('定位前文+引用+后文中的引用,并给出正确区间', () => {
    const text = `看这张\n${note}\n还有一张:${note}。`
    const matches = findAttachmentNotes(text)
    expect(matches).toHaveLength(2)
    expect(text.slice(matches[0]?.start ?? -1, matches[0]?.end ?? -1)).toBe(note)
    expect(text.slice(matches[1]?.start ?? -1, matches[1]?.end ?? -1)).toBe(note)
    expect(matches[0]?.ref.attachmentId).toBe('sha256:abc')
  })

  it('括号与方括号出现在 JSON 字符串值里时不误判', () => {
    const tricky = { ...ref, name: 'a]b{c"d.png' }
    const text = `前文 ${formatAttachmentNote(tricky)} 后文`
    const matches = findAttachmentNotes(text)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.ref.name).toBe('a]b{c"d.png')
  })

  it('不配平/坏 JSON 的片段被跳过', () => {
    expect(findAttachmentNotes('[image attachment {"a":1')).toHaveLength(0)
    expect(findAttachmentNotes('[image attachment not-json]')).toHaveLength(0)
    expect(findAttachmentNotes('普通文本')).toHaveLength(0)
  })
})

describe('raw URL 与裸 JSON 解析', () => {
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'sha256:abc',
    mediaType: 'image/webp',
    bytes: 128,
    width: 64,
    height: 32,
    name: 'shot.webp',
  }
  it('buildRawImageURL 生成可往返的 raw 路径', () => {
    const url = buildRawImageURL(ref)
    expect(url.startsWith(`${API_RAW_PATH}?ref=`)).toBe(true)
    const decoded = decodeURIComponent(url.slice(`${API_RAW_PATH}?ref=`.length))
    expect(parseAttachmentRefJSON(decoded)).toEqual(ref)
  })
})
