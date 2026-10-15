# Trackeee

Trackeee is a high-performance VS Code extension for tracking developer telemetry, coding activity, and active session duration.

---

## Features

- ⏱ **Automatic Time Tracking**: Tracks active coding time across multiple languages, files, and workspaces with zero manual timers.
- 🔒 **Secure Personal Token Access**: Connects securely to your telemetry backend using only your personal access token (`hb_sec_...`). No database keys or sensitive credentials required.
- ⚡ **Real-Time Status Bar**: Live display of today's coding minutes, 24-hour total, or all-time duration right in the status bar.
- 🌐 **Multi-Language Support**: Complete localization support across 12+ languages.
- 🔋 **Battery & Network Efficient**: Debounced and batch-buffered heartbeats to minimize network traffic and system resources.

---

## Installation & Setup

1. **Install the Extension**:
   Install `trackeee` directly from the VS Code Marketplace or install the `.vsix` file:
   ```bash
   code --install-extension trackeee-0.14.0.vsix
   ```

2. **Retrieve Your Token**:
   Open your DevHabit / Habitify desktop app, navigate to **Settings**, and copy your **Personal Access Token** (`hb_sec_...`).

3. **Authenticate in VS Code**:
   - Press <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> (or <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>).
   - Type and select: **`Trackeee: Enter token`**.
   - Paste your copied token and press <kbd>Enter</kbd>.

4. **Verify Connection**:
   You will see the confirmation notification:
   > `Trackeee: Connected successfully! Telemetry active.`
   and the status bar item `$(watch) 0m` will activate immediately.

---

## Configuration Settings

Search for `trackeee` (or `habitify`) in VS Code Settings (`Cmd + ,`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `habitify.serverEntrypoint` | `http://localhost:3001` | Telemetry ingestion API endpoint |
| `codetime.flushInterval` | `60` | Heartbeat flush interval in seconds |
| `codetime.idleTimeout` | `5` | Minutes of inactivity before pausing tracking |
| `codetime.statusBarInfo` | `Today` | Time metric to display: `Today`, `24h`, or `Total` |
| `codetime.enabledLanguages` | `[]` | Whitelist specific languages (empty tracks all) |

---

## Development & Packaging

```bash
# Install dependencies
pnpm install

# Build extension
npm run package

# Package VSIX bundle
npx @vscode/vsce package --no-dependencies
```

---

## License

MIT License.
