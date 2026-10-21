/**
 * dsh-describe-image — Client 半区。
 *
 * 把「图像理解」设置卡注册进 Web 设置面板的 `settings.section` 槽位。
 * 命名空间取 profile entry id,通过官方 `configForms` 通道读写,
 * 不依赖任何第三方设置桥接服务。
 */

import React from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SETTINGS_NAMESPACE } from '../core'
import { DescribeImageSection, type DescribeImageSettings } from './settings'
import { installSendHook } from './send-hook'

export const name = 'dsh-describe-image-client'
/** `slots` 提供槽位注册;`configForms` 提供官方设置读写通道;`conversation` 承载发送拦截。 */
export const inject = ['slots', 'configForms', 'conversation'] as const

interface SlotsLike {
  inject(key: string, factory: () => unknown): () => void
  register(
    options: Record<string, unknown>,
    component: (props: Record<string, unknown>) => React.ReactElement,
  ): () => void
}

interface ClientContextLike {
  slots: SlotsLike
  configForms: { get<T>(entryId: string): ConfigForm<T> }
  /** conversation 服务;缺失时发送拦截静默不装,设置卡不受影响。 */
  conversation?: unknown
  /** cordis effect;用于钩子还原。 */
  effect?(register: () => () => void): void
}

/**
 * 注册设置卡,并安装发送拦截钩子。
 * @param ctx - Client 上下文,提供 slots、configForms 与 conversation。
 */
export function apply(ctx: ClientContextLike): void {
  const scope = ctx.configForms.get<DescribeImageSettings>(SETTINGS_NAMESPACE)

  installSendHook(ctx, ctx.conversation, scope)

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: SETTINGS_NAMESPACE,
        order: 720,
        label: '图像理解',
        // inject 必须是「返回 props 对象的函数」;写成对象字面量会静默失效。
        inject: () => ({ scope }),
      },
      DescribeImageSection as (props: Record<string, unknown>) => React.ReactElement,
    ),
  )
}