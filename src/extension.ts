import * as fs from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import { Habitify } from './codetime'

// 本地化资源缓存
let localizationBundle: Record<string, string> = {}
let currentLanguage: string = ''

/**
 * 加载本地化资源
 * @param context 插件上下文
 * @param language 语言代码，如 zh-cn、ja
 */
async function loadLocalizationResources(context: vscode.ExtensionContext, language: string) {
  // 优先加载 l10n/bundle.l10n.*.json，其次 package.nls.*.json
  const l10nFile = context.asAbsolutePath(path.join('l10n', `bundle.l10n.${language}.json`))
  const nlsFile = context.asAbsolutePath(`package.nls.${language}.json`)
  let loaded = false
  try {
    const l10nContent = await fs.readFile(l10nFile, 'utf8')
    localizationBundle = JSON.parse(l10nContent)
    loaded = true
  }
  catch {}
  if (!loaded) {
    try {
      const nlsContent = await fs.readFile(nlsFile, 'utf8')
      localizationBundle = JSON.parse(nlsContent)
      loaded = true
    }
    catch {}
  }
  if (!loaded) {
    localizationBundle = {}
  }
  currentLanguage = language
}

/**
 * 获取本地化字符串
 * @param key 文本 key
 * @returns 本地化文本，若无则返回 key
 */
export function getLocalizedString(key: string): string {
  return localizationBundle[key] || key
}

let habitify: Habitify

export async function activate(context: vscode.ExtensionContext) {
  // 读取 displayLanguage 配置
  const config = vscode.workspace.getConfiguration('habitify')
  const displayLanguage = config.get('displayLanguage', { title: 'Auto' })
  let language = displayLanguage.title === 'Auto' ? (vscode.env.language ?? '') : displayLanguage.title
  // 统一小写
  language = language.toLowerCase()
  // 动态加载本地化资源
  await loadLocalizationResources(context, language)

  habitify = new Habitify(context.globalState, context.secrets)
  
  // Register command aliases for Trackeee / Habitify
  const registerCmd = (name: string, fn: () => void) => {
    vscode.commands.registerCommand(name, fn)
  }

  registerCmd('habitify.getToken', () => habitify.setToken())
  registerCmd('codetime.getToken', () => habitify.setToken())
  registerCmd('habitify.codeTimeInStatusBar', () => habitify.codeTimeInStatBar())
  registerCmd('codetime.codeTimeInStatusBar', () => habitify.codeTimeInStatBar())
  registerCmd('habitify.toDashboard', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://app.devhabit.com'))
  })
  registerCmd('codetime.toDashboard', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://app.devhabit.com'))
  })

  // 监听配置变更，动态切换语言
  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('habitify.displayLanguage')) {
      const newConfig = vscode.workspace.getConfiguration('habitify')
      const newDisplayLanguage = newConfig.get<string>('displayLanguage', 'Auto')
      const newLang = newDisplayLanguage === 'Auto' ? vscode.env.language : newDisplayLanguage
      if (newLang !== currentLanguage) {
        await loadLocalizationResources(context, newLang)
      }
    }
  })
}

export function deactivate() {
  if (habitify) {
    habitify.dispose()
  }
}
