/**
 * 隔离诊断:验证 dsh-describe-image 的设置命名空间会被 SettingsForms 投影出来。
 *
 * 这直接回答「当前部署未暴露此命名空间」会不会重现:
 * SettingsForms 只收集 **volatile** 字段形成的表单;若 Config 全是普通字段,
 * volatileForm() 返回 undefined,整个 namespace 被跳过,设置卡恒不可用。
 *
 * 本脚本是诊断工具,不是插件运行时依赖:
 * - 不随包发布(package.json#files 不含 scripts/);
 * - 深导入的 dsh-settings 内部 schema 助手仅用于本机验证,
 *   运行时代码只使用公开 SDK。
 *
 * 用法:node scripts/verify-settings-projection.mjs
 */

import { execFileSync } from 'node:child_process'
import { realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 定位全局 dsh 安装目录。 */
function dshInstallDir() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL
  const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  return join(dirname(realpathSync(bin)), '..')
}

const install = dshInstallDir()
const schemaModule = join(install, 'node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js')
if (!existsSync(schemaModule)) {
  console.error(`找不到 dsh-settings 内部 schema 助手:${schemaModule}`)
  process.exit(2)
}

const { volatileForm, projectForm, isVolatilePath, plainConfig } = await import(
  pathToFileURL(schemaModule).href
)
const { Config } = await import('../lib/index.js')

const failures = []
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

// 1. 关键判定:有 volatile 字段时,表单 schema 非空(否则 namespace 被整体跳过)
const form = volatileForm(Config)
check('volatileForm(Config) 非空 => namespace 不会被跳过', form !== undefined)

// 2. 投影出的字段集合应与 Config 一致(sample 需覆盖无默认值的 apiKey)
const parsed = Config({
  baseURL: 'https://vision.example/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-sample',
})
const projected = projectForm(form ?? Config, plainConfig(parsed))
const fields = Object.keys(projected ?? {}).sort()
const expected = [
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
]
check('投影字段与 Config 字段一致', JSON.stringify(fields) === JSON.stringify(expected), fields.join(', '))

// 3. 每个字段都可作为 volatile 路径写入(Client set() 依赖此判定)
for (const field of expected) {
  check(`isVolatilePath(['${field}']) 可写`, isVolatilePath(Config, [field]) === true)
}
check('未知路径不可写', isVolatilePath(Config, ['notAField']) === false)

console.log('')
if (failures.length === 0) {
  console.log('结果:设置命名空间可被 SettingsForms 投影并编辑 ✓')
  process.exit(0)
}
console.error(`结果:${failures.length} 项失败`)
process.exit(1)