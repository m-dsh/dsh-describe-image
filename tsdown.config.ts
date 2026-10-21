import { existsSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const hasClient = existsSync('src/client/index.ts')

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    outDir: 'lib',
    clean: true,
  },
  ...(hasClient
    ? [{
        entry: ['src/client/index.ts'],
        platform: 'browser',
        format: ['cjs'],
        dts: true,
        outDir: 'lib',
        outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
        external: [
          'react',
          'react-dom',
          'react/jsx-runtime',
          '@deepseek-ai/cordis',
        ],
        outputOptions: {
          entryFileNames: 'client.js',
          // module/exports 必须声明在 factory 闭包内部;不能用 intro 放到文件顶层,
          // 否则每个插件的 module/exports 会抢同一个顶层变量。
          banner: [
            'window.__ModuleLoader__.load({',
            `  id: ${JSON.stringify('dsh-describe-image')},`,
            '  factory: (require) => {',
            '    const module = { exports: {} };',
            '    const exports = module.exports;',
          ].join('\n'),
          footer: '    return module.exports;\n  },\n});',
        },
      }]
    : []),
])
