/**
 * 图像理解设置卡。
 *
 * 通过 DSH `0.2.x` 官方的 `ctx.configForms.get(entryId)` 读写 Host 导出的
 * volatile Config,命名空间即 profile entry id(`dsh-describe-image`)。
 * 这条通道不需要手动注册 namespace,也不会被任何第三方 allowlist 过滤——
 * 这正是本插件取代旧全家桶 `webUiSettings.bind()` 通道的原因。
 */

import React, { useEffect, useState } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  API_STYLES,
  DEFAULT_API_KEY_ENV,
  DEFAULT_API_STYLE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
} from '../core'

/** 与 Host Config 的 volatile 字段一一对应的可编辑设置。 */
export interface DescribeImageSettings {
  interceptImageSend?: boolean
  baseURL?: string
  apiStyle?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  defaultPrompt?: string
  maxBytes?: number
  maxOutputTokens?: number
  timeoutMs?: number
}

type FieldKind = 'boolean' | 'text' | 'password' | 'number' | 'select'

interface FieldSpec {
  field: keyof DescribeImageSettings
  label: string
  hint?: string
  kind: FieldKind
  placeholder?: string
  options?: readonly { value: string; label: string }[]
}

const API_STYLE_OPTIONS = [
  { value: 'chat-completions', label: 'Chat Completions(/chat/completions)' },
  { value: 'responses', label: 'Responses(/responses)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages(/v1/messages)' },
] as const

const FIELDS: readonly FieldSpec[] = [
  {
    field: 'interceptImageSend',
    label: '发送时自动改写贴图',
    hint: '开启(默认):发给纯文本模型的贴图在提交时自动入库并改写为 describe_image 引用;支持图片输入的模型自动放行原图。关闭:保持宿主原生行为。',
    kind: 'boolean',
  },
  {
    field: 'baseURL',
    label: '接口地址',
    hint: '端点根地址;按协议自动追加 /chat/completions、/responses 或 /v1/messages。',
    kind: 'text',
    placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { field: 'apiStyle', label: '接口协议', kind: 'select', options: API_STYLE_OPTIONS },
  {
    field: 'model',
    label: '模型',
    hint: '该端点提供的视觉模型 id,例如 qwen-vl-max、glm-4v、gpt-4o-mini。',
    kind: 'text',
    placeholder: 'gpt-4o-mini',
  },
  {
    field: 'apiKey',
    label: 'API Key',
    hint: '留空则改用下面的环境变量引用;明文保存仅建议本地调试使用。',
    kind: 'password',
    placeholder: '留空以使用环境变量',
  },
  {
    field: 'apiKeyEnv',
    label: '密钥环境变量',
    hint: `默认 ${DEFAULT_API_KEY_ENV};留空则禁用环境变量引用。`,
    kind: 'text',
    placeholder: DEFAULT_API_KEY_ENV,
  },
  {
    field: 'defaultPrompt',
    label: '默认指令',
    hint: '模型未传 prompt 时的兜底指令。',
    kind: 'text',
  },
  {
    field: 'maxBytes',
    label: '图片字节上限',
    kind: 'number',
    placeholder: String(DEFAULT_MAX_BYTES),
  },
  {
    field: 'maxOutputTokens',
    label: '输出 token 上限',
    kind: 'number',
    placeholder: String(DEFAULT_MAX_OUTPUT_TOKENS),
  },
  {
    field: 'timeoutMs',
    label: '请求超时(ms)',
    kind: 'number',
    placeholder: String(DEFAULT_TIMEOUT_MS),
  },
]

/** 字段缺省时的展示值(与 Host schema 默认值一致)。 */
function formatField(spec: FieldSpec, raw: unknown): string {
  if (raw === undefined || raw === null) {
    if (spec.kind === 'boolean') return String(true)
    if (spec.field === 'apiStyle') return DEFAULT_API_STYLE
    if (spec.field === 'apiKeyEnv') return DEFAULT_API_KEY_ENV
    return ''
  }
  if (spec.kind === 'boolean') return String(raw !== false)
  return String(raw)
}

/** 设置卡的三种顶层状态。 */
export type SectionStatus = 'loading' | 'unavailable' | 'ready'

/**
 * 把 Host 快照的同步状态收敛为卡片状态。
 * `unavailable` 表示该连接没有暴露本命名空间,是「无法在此编辑」的判定依据。
 * @param snapshot - 至少包含 `status` 的快照。
 * @returns 卡片状态。
 */
export function sectionStatus(snapshot: { status: string }): SectionStatus {
  if (snapshot.status === 'loading') return 'loading'
  if (snapshot.status === 'unavailable') return 'unavailable'
  return 'ready'
}

const h = React.createElement

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 34,
  padding: '0 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
  borderColor: 'transparent',
}

const noticeStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-module-platform)',
}

/**
 * 设置卡组件:展示并提交 describe_image 的端点配置。
 * @param props - 由 slot 的 `inject()` 合并后的属性,含 `scope`。
 * @returns 设置卡元素。
 */
export function DescribeImageSection(props: Record<string, unknown>): React.ReactElement {
  const scope = (props as unknown as { scope: ConfigForm<DescribeImageSettings> }).scope
  const [snap, setSnap] = useState<ConfigFormSnapshot<DescribeImageSettings>>(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  const [draft, setDraft] = useState<Partial<Record<keyof DescribeImageSettings, string>>>({})
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | undefined>(undefined)

  const value = snap.value ?? {}
  const writable = snap.writable && snap.status === 'ready'
  const dirty = Object.keys(draft).length > 0
  const status = sectionStatus(snap)

  if (status === 'loading') {
    return h('div', { style: noticeStyle, role: 'status' }, '正在读取图像理解设置…')
  }

  if (status === 'unavailable') {
    return h(
      'div',
      { style: noticeStyle, role: 'status' },
      '当前连接没有暴露 dsh-describe-image 设置命名空间。请确认该插件已在 Host 加载,并刷新页面。',
    )
  }

  const textOf = (spec: FieldSpec): string =>
    draft[spec.field] ?? formatField(spec, value[spec.field])

  const edit = (field: keyof DescribeImageSettings, text: string): void => {
    setPhase('idle')
    setMessage(undefined)
    setDraft((previous) => ({ ...previous, [field]: text }))
  }

  const discard = (): void => {
    setDraft({})
    setPhase('idle')
    setMessage(undefined)
  }

  const save = (): void => {
    void (async () => {
      if (!dirty || !writable) return
      setPhase('saving')
      setMessage(undefined)
      try {
        for (const spec of FIELDS) {
          const staged = draft[spec.field]
          if (staged === undefined) continue
          // 布尔开关永远有值,不能走「空串 unset」路径。
          if (spec.kind === 'boolean') {
            await scope.set(spec.field, staged === 'true')
            continue
          }
          const trimmed = staged.trim()
          if (trimmed === '') {
            await scope.unset(spec.field)
            continue
          }
          if (spec.kind === 'number') {
            const parsed = Number(trimmed)
            if (!Number.isFinite(parsed) || parsed <= 0) {
              setPhase('error')
              setMessage(`${spec.label} 需要大于 0 的数字。`)
              return
            }
            await scope.set(spec.field, parsed)
            continue
          }
          await scope.set(spec.field, trimmed)
        }
        setDraft({})
        setPhase('saved')
      } catch {
        setPhase('error')
        setMessage('保存失败,请检查连接后重试。')
      }
    })()
  }

  const children: React.ReactNode[] = [
    h(
      'div',
      { key: 'header', style: fieldStyle },
      h('span', { style: { ...labelStyle, fontSize: 14 } }, '图像理解'),
      h(
        'span',
        { style: hintStyle },
        'describe_image 工具所调用的视觉语言端点。保存后即时生效,无需重启。',
      ),
    ),
  ]

  if (!writable) {
    children.push(
      h('div', { key: 'readonly', style: noticeStyle, role: 'status' }, '当前部署的设置为只读。'),
    )
  }

  for (const spec of FIELDS) {
    // 布尔开关用 checkbox;draft 存字符串,展示与提交时再收敛。
    if (spec.kind === 'boolean') {
      const checked = draft[spec.field] !== undefined
        ? draft[spec.field] === 'true'
        : value[spec.field] !== false
      children.push(
        h(
          'label',
          {
            key: `field-${spec.field}`,
            style: { ...fieldStyle, flexDirection: 'row', alignItems: 'center', gap: 8 },
          },
          h('input', {
            key: spec.field,
            type: 'checkbox',
            checked,
            disabled: !writable,
            'aria-label': spec.label,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              edit(spec.field, String(event.target.checked)),
          }),
          h('span', { style: labelStyle }, spec.label),
          spec.hint === undefined ? null : h('span', { style: hintStyle }, spec.hint),
        ),
      )
      continue
    }
    const inputProps: Record<string, unknown> = {
      style: inputStyle,
      value: textOf(spec),
      disabled: !writable,
      'aria-label': spec.label,
      placeholder: spec.placeholder,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        edit(spec.field, event.target.value),
    }
    const control =
      spec.kind === 'select'
        ? h(
            'select',
            { ...inputProps, key: spec.field },
            ...(spec.options ?? []).map((option) =>
              h('option', { key: option.value, value: option.value }, option.label),
            ),
          )
        : h('input', {
            ...inputProps,
            key: spec.field,
            type: spec.kind === 'number' ? 'number' : spec.kind === 'password' ? 'password' : 'text',
            min: spec.kind === 'number' ? 1 : undefined,
          })

    children.push(
      h(
        'label',
        { key: `field-${spec.field}`, style: fieldStyle },
        h('span', { style: labelStyle }, spec.label),
        control,
        spec.hint === undefined ? null : h('span', { style: hintStyle }, spec.hint),
      ),
    )
  }

  const footer: React.ReactNode[] = []
  if (message !== undefined) {
    footer.push(h('span', { key: 'message', style: { ...hintStyle, color: 'var(--dsw-alias-label-error)' } }, message))
  } else if (phase === 'saved') {
    footer.push(h('span', { key: 'saved', style: hintStyle }, '已保存'))
  } else if (dirty) {
    footer.push(h('span', { key: 'dirty', style: hintStyle }, '有未保存的修改'))
  }
  footer.push(
    h(
      'button',
      {
        key: 'discard',
        type: 'button',
        style: buttonStyle,
        disabled: !dirty || phase === 'saving',
        onClick: discard,
      },
      '放弃修改',
    ),
    h(
      'button',
      {
        key: 'save',
        type: 'button',
        style: primaryButtonStyle,
        disabled: !dirty || !writable || phase === 'saving',
        onClick: save,
      },
      phase === 'saving' ? '保存中…' : '保存',
    ),
  )

  children.push(
    h(
      'div',
      {
        key: 'footer',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
      },
      ...footer,
    ),
  )

  return h('div', { style: cardStyle }, ...children)
}