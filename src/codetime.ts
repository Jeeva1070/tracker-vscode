import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import tls from 'node:tls'

import osName from 'os-name'
import * as vscode from 'vscode'
import * as events from './events'
import { getDurationText } from './getDurationText'
import { getGitCurrentBranch, getGitOriginUrl } from './utils'

export class Habitify {
  osName = osName()
  out: vscode.OutputChannel = vscode.window.createOutputChannel('Trackeee')
  private debounceTimer?: NodeJS.Timeout
  private secrets: vscode.SecretStorage
  private readonly platformArch = os.arch()
  private authRetryCount = 0
  private readonly maxAuthRetries = 3

  private debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
    return (...args: Parameters<T>) => {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => func.apply(this, args), wait)
    }
  }

  async setToken() {
    const token = await vscode.window.showInputBox({
      password: true,
      prompt: 'Trackeee: Enter your Personal Token (from DevHabit Settings)',
      placeHolder: 'hb_sec_...',
      ignoreFocusOut: true,
    })

    if (token) {
      const cleanToken = token.trim()
      await this.secrets.store('devhabit.token', cleanToken)
      await this.secrets.store('habitify.token', cleanToken)
      this.token = cleanToken
      await this.verifyTokenAndInit(true)
    }
  }

  async verifyTokenAndInit(showNotification = false) {
    if (!this.token) {
      this.statusBar.text = '$(key) Trackeee: Set Token'
      this.statusBar.tooltip = 'Click to enter your Personal Access Token'
      this.statusBar.command = 'habitify.getToken'
      return false
    }

    const config = vscode.workspace.getConfiguration('habitify')
    const fallbackConfig = vscode.workspace.getConfiguration('codetime')
    const serverUrl = config.get<string>('serverEntrypoint')
      || fallbackConfig.get<string>('serverEntrypoint')
      || 'http://localhost:3001'

    const isSupabase = serverUrl.includes('supabase.co')
    const endpoint = isSupabase ? '/rpc/verify_extension_token' : '/api/auth/verify'
    const body = isSupabase ? { p_token: this.token } : { token: this.token }

    try {
      const res = await this.apiRequest('POST', endpoint, body)
      const data = JSON.parse(res.body || '{}')

      if (data.valid || data.success) {
        this.resetAuthRetryCount()
        const user = data.user?.displayName || data.displayName || 'Connected'
        this.statusBar.text = '$(watch) Trackeee: Active'
        this.statusBar.tooltip = `Trackeee: Connected as @${user} · Telemetry active`
        this.statusBar.command = 'habitify.toDashboard'
        if (showNotification) {
          vscode.window.showInformationMessage(`Trackeee: Connected successfully as @${user}! Telemetry active.`)
        }
        this.getCurrentDuration()
        return true
      }
      else {
        this.handleTokenInvalid()
        if (showNotification) {
          vscode.window.showErrorMessage('Trackeee: Invalid token. Please check your token in DevHabit Settings.')
        }
        return false
      }
    }
    catch (err: any) {
      this.out.appendLine(`[Token Verify Error] ${err.message || err}`)
      // Fallback: if offline or self-hosted, still accept validly-formatted tokens
      if (this.token.startsWith('hb_sec_') || this.token.startsWith('dh_')) {
        this.statusBar.text = '$(watch) Trackeee: Ready'
        this.statusBar.tooltip = 'Trackeee: Token saved (offline mode)'
        if (showNotification) {
          vscode.window.showInformationMessage('Trackeee: Token saved! Telemetry active.')
        }
        return true
      }
      this.handleTokenInvalid()
      return false
    }
  }

  private statusBar: vscode.StatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  )

  public disposable!: vscode.Disposable
  state: vscode.Memento
  token: string = ''
  inter!: NodeJS.Timeout
  constructor(state: vscode.Memento, secrets: vscode.SecretStorage) {
    this.state = state
    this.secrets = secrets
    this.initSetToken().then(() => {
      this.init()
    })
  }

  private getProxyUrl(): string {
    return (
      vscode.workspace.getConfiguration('habitify').get<string>('proxy')
      || vscode.workspace.getConfiguration('codetime').get<string>('proxy')
      || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      || process.env.https_proxy || process.env.http_proxy
      || ''
    )
  }

  private apiRequest(method: string, path: string, body?: any): Promise<{ body: string, statusCode: number }> {
    const config = vscode.workspace.getConfiguration('habitify')
    const fallbackConfig = vscode.workspace.getConfiguration('codetime')
    let serverUrl = config.get<string>('serverEntrypoint')
      || fallbackConfig.get<string>('serverEntrypoint')
      || 'https://cqdwtumqcxpvhsqfwhsm.supabase.co/rest/v1'
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      serverUrl = `https://${serverUrl}`
    }
    serverUrl = serverUrl.replace(/\/+$/, '')

    let resolvedPath = path
    if (serverUrl.includes('supabase.co') && !serverUrl.endsWith('/rest/v1') && !path.startsWith('/rest/v1')) {
      resolvedPath = `/rest/v1${path.startsWith('/') ? path : `/${path}`}`
    }

    const url = new URL(resolvedPath, serverUrl)
    const payload = body ? JSON.stringify(body) : undefined
    const proxy = this.getProxyUrl()
    const isHttpsTarget = url.protocol === 'https:'
    const targetPort = Number(url.port) || (isHttpsTarget ? 443 : 80)

    const apiKey = config.get<string>('apiKey', '') || this.token
    const baseHeaders: Record<string, string> = {
      'User-Agent': 'Trackeee Client',
    }
    if (apiKey) {
      baseHeaders['apikey'] = apiKey
      baseHeaders['Authorization'] = `Bearer ${this.token || apiKey}`
    }
    else if (this.token) {
      baseHeaders['Authorization'] = `Bearer ${this.token}`
    }
    if (payload) {
      baseHeaders['Content-Type'] = 'application/json'
      baseHeaders['Content-Length'] = Buffer.byteLength(payload).toString()
      baseHeaders['Prefer'] = 'return=minimal'
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      this.out.appendLine(`[Req] ${method} ${path} proxy=${proxy ? this.redactUrlForLogging(proxy) : 'none'}`)

      const finish = (parsed: { statusCode: number, body: string }) => {
        this.out.appendLine(`[Req] ${parsed.statusCode} after ${Date.now() - startTime}ms`)
        if (parsed.statusCode >= 400) {
          const message = parsed.statusCode === 401 ? 'Unauthorized' : `HTTP ${parsed.statusCode}`
          const err = new Error(message) as Error & { response: { statusCode: number, body: string } }
          err.response = { statusCode: parsed.statusCode, body: parsed.body }
          reject(err)
          return
        }
        resolve(parsed)
      }

      // No proxy: use Node's http(s) client directly
      if (!proxy) {
        const lib = isHttpsTarget ? https : http
        const req = lib.request({
          method,
          hostname: url.hostname,
          port: targetPort,
          path: url.pathname + url.search,
          timeout: 30_000,
          headers: baseHeaders,
        }, (res: http.IncomingMessage) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            finish({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        })
        req.on('error', (e: any) => {
          this.out.appendLine(`[Req] error after ${Date.now() - startTime}ms: ${e.message}`)
          reject(e)
        })
        req.on('timeout', () => req.destroy(new Error('request timeout')))
        if (payload) {
          req.write(payload)
        }
        req.end()
        return
      }

      // With proxy: open TCP/TLS to proxy, then CONNECT (HTTPS target) or absolute-form (HTTP target)
      let proxyUrlParsed: URL
      try {
        proxyUrlParsed = new URL(proxy)
      }
      catch {
        const error = new Error(`Invalid proxy URL: "${this.redactUrlForLogging(proxy)}". Expected format: http://host:port or https://host:port.`)
        this.out.appendLine(`[Req] invalid proxy configuration: ${error.message}`)
        reject(error)
        return
      }
      if (proxyUrlParsed.protocol !== 'http:' && proxyUrlParsed.protocol !== 'https:') {
        const error = new Error(`Unsupported proxy protocol: ${proxyUrlParsed.protocol}. Only http: and https: proxies are supported.`)
        this.out.appendLine(`[Req] invalid proxy configuration: ${error.message}`)
        reject(error)
        return
      }
      const isHttpsProxy = proxyUrlParsed.protocol === 'https:'
      const proxyPort = Number(proxyUrlParsed.port) || (isHttpsProxy ? 443 : 80)
      const proxyHost = proxyUrlParsed.hostname
      const targetAuthority = url.hostname.includes(':') ? `[${url.hostname}]:${targetPort}` : `${url.hostname}:${targetPort}`

      const proxyAuthHeader = proxyUrlParsed.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrlParsed.username)}:${decodeURIComponent(proxyUrlParsed.password)}`).toString('base64')}`
        : ''

      this.out.appendLine(`[Req] connecting to proxy ${proxyHost}:${proxyPort} (${proxyUrlParsed.protocol})`)

      const writeRequestAndRead = (socket: net.Socket | tls.TLSSocket, requestLine: string, extraHeaders: string[] = []) => {
        const lines = [
          requestLine,
          `Host: ${url.host}`,
          ...Object.entries(baseHeaders).map(([k, v]) => `${k}: ${v}`),
          ...extraHeaders,
          'Connection: close',
          '',
          payload || '',
        ]
        socket.write(lines.join('\r\n'))

        const requestTimeout = setTimeout(() => {
          socket.destroy(new Error('request timeout'))
        }, 30_000)

        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.on('end', () => {
          clearTimeout(requestTimeout)
          socket.destroy()
          try {
            finish(parseHttpResponse(Buffer.concat(chunks)))
          }
          catch (error: any) {
            this.out.appendLine(`[Req] parse error: ${error.message}`)
            reject(error)
          }
        })
        socket.on('error', (e: any) => {
          clearTimeout(requestTimeout)
          this.out.appendLine(`[Req] socket error: ${e.message}`)
          reject(e)
        })
      }

      const onProxyReady = (proxySocket: net.Socket | tls.TLSSocket) => {
        if (!isHttpsTarget) {
          this.out.appendLine(`[Req] proxy connected, sending HTTP request (absolute form)`)
          proxySocket.setTimeout(0)
          writeRequestAndRead(
            proxySocket,
            `${method} ${url.toString()} HTTP/1.1`,
            proxyAuthHeader ? [proxyAuthHeader] : [],
          )
          return
        }

        this.out.appendLine(`[Req] proxy connected, sending CONNECT`)
        const connectLines = [
          `CONNECT ${targetAuthority} HTTP/1.1`,
          `Host: ${targetAuthority}`,
          ...(proxyAuthHeader ? [proxyAuthHeader] : []),
          'Proxy-Connection: keep-alive',
          '',
          '',
        ]
        proxySocket.write(connectLines.join('\r\n'))

        let connectBuf = Buffer.alloc(0)
        const onConnectData = (chunk: Buffer) => {
          connectBuf = Buffer.concat([connectBuf, chunk])
          const idx = connectBuf.indexOf('\r\n\r\n')
          if (idx === -1) {
            return
          }
          proxySocket.removeListener('data', onConnectData)
          const headerStr = connectBuf.slice(0, idx).toString('utf8')
          const statusLine = headerStr.split('\r\n')[0]
          this.out.appendLine(`[Req] proxy response: ${statusLine}`)
          const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
          if (!m || m[1] !== '200') {
            proxySocket.destroy()
            reject(new Error(`Proxy CONNECT failed: ${statusLine}`))
            return
          }
          proxySocket.setTimeout(0)
          const residue = connectBuf.slice(idx + 4)
          if (residue.length > 0) {
            proxySocket.unshift(residue)
          }
          const tlsSocket = tls.connect({ socket: proxySocket, servername: url.hostname }, () => {
            this.out.appendLine(`[Req] TLS handshake done, sending HTTP request`)
            writeRequestAndRead(tlsSocket, `${method} ${url.pathname + url.search} HTTP/1.1`)
          })
          tlsSocket.on('error', (e: any) => {
            this.out.appendLine(`[Req] TLS error: ${e.message}`)
            reject(e)
          })
        }
        proxySocket.on('data', onConnectData)
      }

      const proxySocket: net.Socket | tls.TLSSocket = isHttpsProxy
        ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost }, () => onProxyReady(proxySocket))
        : net.connect(proxyPort, proxyHost, () => onProxyReady(proxySocket))
      proxySocket.setTimeout(10_000, () => {
        proxySocket.destroy()
        reject(new Error('Proxy connection timeout'))
      })
      proxySocket.on('error', (e: any) => {
        this.out.appendLine(`[Req] proxy socket error: ${e.code || ''} ${e.message}`)
        reject(e)
      })
    })
  }

  async initSetToken() {
    const secretToken = (await this.secrets.get('devhabit.token'))
      || (await this.secrets.get('habitify.token'))
      || (await this.secrets.get('codetime.token'))
    const envToken = process.env.DEVHABIT_TOKEN || process.env.HABITIFY_TOKEN || process.env.CODETIME_TOKEN

    if (secretToken) {
      this.token = secretToken
    }
    else if (envToken) {
      this.token = envToken
      await this.secrets.store('devhabit.token', envToken)
    }

    if (this.token === '') {
      await this.setToken()
    }
  }

  private redactUrlForLogging(url?: string): string {
    if (!url) {
      return '(none)'
    }

    try {
      const parsed = new URL(url)
      parsed.username = ''
      parsed.password = ''
      parsed.pathname = ''
      parsed.search = ''
      parsed.hash = ''
      return `${parsed.protocol}//${parsed.host}`
    }
    catch {
      return '(configured)'
    }
  }

  private init(): void {
    const serverUrl = vscode.workspace.getConfiguration('habitify').get<string>('serverEntrypoint')
      || vscode.workspace.getConfiguration('codetime').get<string>('serverEntrypoint')
    this.out.appendLine(`[Init] proxy=${this.redactUrlForLogging(this.getProxyUrl())}`)
    this.out.appendLine(`[Init] serverEntrypoint=${serverUrl}`)
    this.out.appendLine(`[Init] token=${this.token ? `***${this.token.slice(-4)}` : '(empty)'}`)

    this.statusBar.text = `$(clock) Trackeee: Initializing...`
    this.statusBar.show()
    this.setupEventListeners()
    this.drainOfflineQueue()
    this.getCurrentDuration()
    this.inter = setInterval(() => {
      this.drainOfflineQueue()
      this.getCurrentDuration()
    }, 10 * 1000)
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    const events: vscode.Disposable[] = []
    vscode.workspace.onDidChangeTextDocument(this.onEdit, this, events)
    vscode.window.onDidChangeActiveTextEditor(this.onEditor, this, events)
    vscode.window.onDidChangeTextEditorSelection(this.onChangeTextEditorSelection, this, events)
    vscode.window.onDidChangeTextEditorVisibleRanges(this.debounce(this.onChangeTextEditorVisibleRanges, 300), this, events)
    vscode.window.onDidChangeWindowState(this.onFocus, this, events)
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, events)
    vscode.workspace.onDidCreateFiles(this.onCreate, this, events)
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('habitify') || e.affectsConfiguration('codetime')) {
        this.getCurrentDuration()
      }
    })
    this.disposable = vscode.Disposable.from(...events)
  }

  private onEdit(e: vscode.TextDocumentChangeEvent) {
    let eventName = events.FILE_EDITED
    // 如果 document 是 output channel 的话，不记录
    if (e.document.uri.scheme === 'output') {
      return
    }

    if (e.contentChanges.length === 1
      && /\r\n|\n|\r/.test(e.contentChanges[0].text)) {
      eventName = events.FILE_ADDED_LINE
      this.onChange(eventName)
    }
    else if (Math.random() > 0.9) {
      this.onChange(eventName)
    }
  }

  private onEditor(_e: vscode.TextEditor | undefined) {
    this.onChange(events.ACTIVATE_FILE_CHANGED)
  }

  private onChangeTextEditorSelection(e: vscode.TextEditorSelectionChangeEvent) {
    if (e.textEditor.document.uri.scheme === 'output') {
      return
    }

    if (Math.random() > 0.9) {
      this.onChange(events.CHANGE_EDITOR_SELECTION)
    }
  }

  private onChangeTextEditorVisibleRanges(_e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (_e.textEditor.document.uri.scheme === 'output') {
      return
    }

    this.onChange(events.CHANGE_EDITOR_VISIBLE_RANGES)
  }

  private onFocus(_e: vscode.WindowState) {
    this.onChange(events.EDITOR_CHANGED)
  }

  private onCreate() {
    this.onChange(events.FILE_CREATED)
  }

  private onSave(_e: vscode.TextDocument) {
    this.onChange(events.FILE_SAVED)
  }

  private getOperationType(eventName = 'unknown'): 'read' | 'write' {
    switch (eventName) {
      case events.FILE_CREATED:
      case events.FILE_EDITED:
      case events.FILE_ADDED_LINE:
      case events.FILE_REMOVED:
      case events.FILE_SAVED: {
        return 'write'
      }
      default: {
        return 'read'
      }
    }
  }

  private onChange(eventName = 'unknown') {
    const editor = vscode.window.activeTextEditor
    const workspaceName = vscode.workspace.name || 'default-workspace'
    const workspaceRoot = vscode.workspace.workspaceFolders
    if (workspaceRoot && editor) {
      const doc = editor.document
      if (doc && doc.uri.scheme !== 'output') {
        const lang = doc.languageId
        const absoluteFilePath = doc.fileName
        let relativeFilePath = vscode.workspace.asRelativePath(
          absoluteFilePath,
        )
        if (relativeFilePath === absoluteFilePath) {
          relativeFilePath = path.basename(absoluteFilePath)
        }

        if (relativeFilePath) {
          const config = vscode.workspace.getConfiguration('codetime')
          const enabledLanguages = config.get<string[]>('enabledLanguages', [])
          if (enabledLanguages && enabledLanguages.length > 0 && !enabledLanguages.includes(lang)) {
            return
          }

          const flushInterval = config.get<number>('flushInterval', 10)
          const branch = getGitCurrentBranch()
          const userId = config.get<string>('userId') || 'user_developer'
          if (!this.token) {
            this.statusBar.text = '$(key) Trackeee: Set Token'
            this.statusBar.tooltip = 'Click to enter your Personal Access Token'
            this.statusBar.command = 'habitify.getToken'
            return
          }

          const heartbeat = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            duration_seconds: flushInterval,
            language: lang,
            workspace_name: workspaceName,
            platform: process.platform,
            file_path: relativeFilePath,
            branch: branch || null,
          }
          this.out.appendLine(`[Heartbeat] ${JSON.stringify(heartbeat)}`)

          const serverUrl = config.get<string>('serverEntrypoint')
            || vscode.workspace.getConfiguration('codetime').get<string>('serverEntrypoint')
            || 'http://localhost:3001'

          const isSupabase = serverUrl.includes('supabase.co')
          const endpoint = isSupabase ? '/rpc/ingest_heartbeat_with_token' : '/api/heartbeats'
          const payload = isSupabase
            ? { p_token: this.token, p_heartbeat: heartbeat }
            : { ...heartbeat, token: this.token }

          this.apiRequest('POST', endpoint, payload).then((res: any) => {
            try {
              const data = JSON.parse(res.body || '{}')
              if (data.todayMinutes !== undefined) {
                this.statusBar.text = `$(watch) ${data.todayMinutes}m`
                this.statusBar.tooltip = `Trackeee: ${data.todayMinutes}m coded today`
              }
            }
            catch {}
            // When an upload succeeds, drain any pending offline items
            this.drainOfflineQueue()
          }).catch((error: any) => {
            if (error.response?.statusCode === 401) {
              this.handleAuthError()
            }
            else {
              this.out.appendLine(`[Heartbeat Offline]: ${error.message || error}`)
              // Persist heartbeat to on-disk SQLite queue so work is never lost
              this.enqueueOfflineHeartbeat(heartbeat)
            }
          })
        }
      }
    }
  }

  // MARK: - On-Disk Persistent Offline Queue (Backed by VS Code SQLite state.vscdb)
  private readonly QUEUE_STORAGE_KEY = 'trackeee.offline_heartbeats'
  private isDrainingQueue = false

  private async enqueueOfflineHeartbeat(heartbeat: any) {
    try {
      const queue: any[] = this.state.get<any[]>(this.QUEUE_STORAGE_KEY, [])
      // Cap at 10,000 heartbeats (up to ~160 hours of continuous offline typing)
      if (queue.length < 10000) {
        queue.push(heartbeat)
        await this.state.update(this.QUEUE_STORAGE_KEY, queue)
        this.out.appendLine(`[Offline Queue] Persisted heartbeat ${heartbeat.id} to disk. Total queued: ${queue.length}`)
        this.statusBar.text = `$(cloud-offline) ${queue.length} queued`
        this.statusBar.tooltip = `Trackeee: Offline · ${queue.length} heartbeats saved to disk`
      }
    }
    catch (e) {
      this.out.appendLine(`[Offline Queue Error] Failed to persist: ${e}`)
    }
  }

  private async drainOfflineQueue() {
    if (this.isDrainingQueue || !this.token) {
      return
    }

    const queue: any[] = this.state.get<any[]>(this.QUEUE_STORAGE_KEY, [])
    if (!queue || queue.length === 0) {
      return
    }

    this.isDrainingQueue = true
    this.out.appendLine(`[Offline Queue] Replaying ${queue.length} offline heartbeats from disk...`)

    const config = vscode.workspace.getConfiguration('habitify')
    const serverUrl = config.get<string>('serverEntrypoint')
      || vscode.workspace.getConfiguration('codetime').get<string>('serverEntrypoint')
      || 'http://localhost:3001'
    const isSupabase = serverUrl.includes('supabase.co')
    const endpoint = isSupabase ? '/rpc/ingest_heartbeat_with_token' : '/api/heartbeats'

    let successCount = 0
    let failedIndex = -1

    for (let i = 0; i < queue.length; i++) {
      const hb = queue[i]
      const payload = isSupabase ? { p_token: this.token, p_heartbeat: hb } : { ...hb, token: this.token }
      try {
        await this.apiRequest('POST', endpoint, payload)
        successCount++
      }
      catch (err: any) {
        // If still offline, stop and keep remaining items on disk
        failedIndex = i
        break
      }
    }

    const remaining = failedIndex >= 0 ? queue.slice(failedIndex) : []
    await this.state.update(this.QUEUE_STORAGE_KEY, remaining)
    this.out.appendLine(`[Offline Queue] Replayed ${successCount} heartbeats. ${remaining.length} remaining on disk.`)
    this.isDrainingQueue = false

    if (remaining.length === 0) {
      this.getCurrentDuration()
    }
    else {
      this.statusBar.text = `$(cloud-offline) ${remaining.length} queued`
    }
  }

  private handleAuthError() {
    this.authRetryCount++

    if (this.authRetryCount <= this.maxAuthRetries) {
      this.out.appendLine(`Authentication failed, retrying (${this.authRetryCount}/${this.maxAuthRetries})...`)
      this.statusBar.text = `$(clock) Trackeee: Auth Failed`
      this.statusBar.tooltip = 'Trackeee: Authentication retry, please wait...'
      this.statusBar.command = 'habitify.getToken'
    }
    else {
      this.out.appendLine('Max authentication retries exceeded, token invalid')
      this.handleTokenInvalid()
    }
  }

  private handleTokenInvalid() {
    this.authRetryCount = 0
    this.statusBar.text = `$(key) Trackeee: Set Token`
    this.statusBar.tooltip = 'Click to enter your Personal Token (from DevHabit Settings)'
    this.statusBar.command = 'habitify.getToken'
  }

  private resetAuthRetryCount() {
    this.authRetryCount = 0
  }

  private getCurrentDuration(showSuccess = false) {
    if (!this.token) {
      this.statusBar.text = `$(key) Trackeee: Set Token`
      this.statusBar.tooltip = 'Click to enter your Personal Access Token'
      this.statusBar.command = 'habitify.getToken'
      return
    }

    const config = vscode.workspace.getConfiguration('habitify')
    const serverUrl = config.get<string>('serverEntrypoint')
      || vscode.workspace.getConfiguration('codetime').get<string>('serverEntrypoint')
      || 'http://localhost:3001'

    const isSupabase = serverUrl.includes('supabase.co')
    const endpoint = isSupabase ? '/rpc/get_token_today_duration' : '/api/stats'
    const method = isSupabase ? 'POST' : 'GET'
    const body = isSupabase ? { p_token: this.token } : undefined

    this.apiRequest(method, endpoint, body).then(async (res: any) => {
      try {
        const data = JSON.parse(res.body || '{}')
        const minutes = data.todayMinutes !== undefined ? data.todayMinutes : (data.totalMinutes || 0)
        this.statusBar.text = `$(watch) ${minutes}m`
        this.statusBar.tooltip = `Trackeee: ${minutes}m coded today`
        this.resetAuthRetryCount()
        if (showSuccess) {
          vscode.window.showInformationMessage(`Trackeee: Connected! ${minutes}m tracked today.`)
        }
      }
      catch (e) {
        this.out.appendLine(`[Stats] Parse error: ${e}`)
      }
    }).catch((error: any) => {
      const errMsg = error.message || error || 'Unknown error'
      if (error.response?.statusCode === 401) {
        this.handleAuthError()
      }
      else {
        this.out.appendLine(`[Duration Error]: ${errMsg}`)
      }
    })
  }

  public codeTimeInStatBar() {
    vscode.window
      .showQuickPick(
        [
          vscode.l10n.t('Total code time'),
          vscode.l10n.t('24h code time'),
          vscode.l10n.t('Today code time'),
        ],
        {},
      )
      .then((v) => {
        let key = 'Total'
        switch (v) {
          case vscode.l10n.t('24h code time'): {
            key = '24h'
            break
          }
          case vscode.l10n.t('Today code time'): {
            key = 'Today'
            break
          }
          default: {
            break
          }
        }
        vscode.workspace
          .getConfiguration('habitify')
          .update('statusBarInfo', key, true)
          .then(() => this.getCurrentDuration())
      })
  }

  public dispose() {
    this.statusBar.dispose()
    this.disposable.dispose()
    clearInterval(this.inter)
  }
}

function parseHttpResponse(buf: Buffer): { statusCode: number, body: string } {
  const headerEnd = buf.indexOf('\r\n\r\n')
  if (headerEnd === -1) {
    throw new Error('Incomplete HTTP response (no header terminator)')
  }
  const headerText = buf.slice(0, headerEnd).toString('utf8')
  const lines = headerText.split('\r\n')
  const statusLine = lines[0] || ''
  const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
  if (!m) {
    throw new Error(`Invalid status line: ${statusLine}`)
  }
  const statusCode = Number(m[1])
  const headers = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx > 0) {
      headers.set(lines[i].slice(0, idx).trim().toLowerCase(), lines[i].slice(idx + 1).trim())
    }
  }
  const rawBody = buf.slice(headerEnd + 4)
  const isChunked = (headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')
  const bodyBuf = isChunked ? decodeChunked(rawBody) : rawBody
  return { statusCode, body: bodyBuf.toString('utf8') }
}

function decodeChunked(buf: Buffer): Buffer {
  const out: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    const sizeLineEnd = buf.indexOf('\r\n', offset)
    if (sizeLineEnd === -1) {
      break
    }
    const sizeHex = buf.slice(offset, sizeLineEnd).toString('utf8').split(';')[0].trim()
    const size = Number.parseInt(sizeHex, 16)
    if (Number.isNaN(size)) {
      throw new TypeError(`Invalid chunk size: ${sizeHex}`)
    }
    if (size === 0) {
      break
    }
    const dataStart = sizeLineEnd + 2
    out.push(buf.slice(dataStart, dataStart + size))
    offset = dataStart + size + 2
  }
  return Buffer.concat(out)
}

function getMinutes(key: string) {
  let minutes = 60 * 24
  switch (key) {
    case 'Today': {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
      const hours = now.getHours()
      minutes = now.getMinutes()
      minutes += hours * 60
      break
    }
    case 'Total': {
      minutes = 60 * 24 * 365 * 100
      break
    }
    case '24h': {
      minutes = 60 * 24
      break
    }
    default: {
      minutes = 60 * 24 * 365 * 100
      break
    }
  }
  return minutes
}
