# CP/M IDE

A VS Code extension for CP/M application development with an integrated serial terminal, a fast custom transfer protocol, and file transfer/build tooling.

![Integrated environment](https://raw.githubusercontent.com/rockcat/cpm_ide/refs/heads/main/screenshots/workspace.png)

## Features

### 🔌 Integrated Serial Terminal

- Configurable serial connection: port, baud rate, data bits, stop bits, parity, and flow control (none/Xon-Xoff/RTS-CTS)
- Fixed-grid terminal display (80x25, 64x16, 40x24, 52x24) with an adjustable text color and a "Force caps" input mode
- Automatic detection of CP/M command prompts (`A>`, `B>`, etc.)
- Detects and displays the connected device's CP/M version (e.g. "CP/M 2.2") once it's learned from a Remote CCP session
- Optional TX/RX hex-dump logging to a dedicated output channel, for diagnosing comms issues
- Transparent background command execution for device management (drive selects, directory scans, etc. run without cluttering the visible terminal)
- The terminal panel opens in the same editor group as whatever is currently rightmost, instead of always splitting open a new column

### 📁 File Transfer System

- Integrated file explorer (CP/M IDE sidebar) showing remote CP/M drives/files alongside a local workspace file tree
- **Remote CCP** - a small custom resident program (see below) used as the primary, fastest path for scanning drives/files and for all automatic transfers
- **XMODEM** - the original transfer protocol, used as an automatic fallback when Remote CCP isn't available, plus dedicated manual send/receive commands
- **Slide** - a windowed, CRC16, multi-file batch transfer protocol for sending several files to a drive in one go
- Automatic `PIP` copy of whichever helper (`REMOTCCP.COM`, `XMODEM.COM`, or `SLIDECPM.COM`) is needed from `A:` to the target drive
- Target-drive picker before each upload

### 🖥️ Z80 Assembly Support

- Complete Z80 assembly syntax highlighting
- Support for various assembly syntaxes and directives
- Mnemonics highlighting for all standard Z80 instructions
- Numeric format support (hex, binary, decimal, octal)

### 🔨 Build Integration

- Support for local Z80 assembler integration
- C compiler integration for building `.COM` files
- Optional Makefile-driven builds (used automatically when a Makefile is present and `cpmIde.makeCommand` is configured)
- Configurable build tools via settings
- Build output captured in a dedicated channel

## Installation

### Local development

1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Open the folder in VS Code and press `F5` to launch the Extension Development Host

### Package or publish

1. Make sure the `publisher` value in `package.json` matches your Visual Studio Marketplace publisher name
2. Bump the extension version in `package.json`
3. Package a `.vsix` file with `npx @vscode/vsce package`
4. Publish to the Marketplace with `npx @vscode/vsce publish patch`
5. Use `minor` or `major` instead of `patch` when you want a larger version bump

## Configuration

Configure the extension via VS Code settings:

```json
{
  "cpmIde.serialPort": "COM1",
  "cpmIde.baudRate": 9600,
  "cpmIde.dataBits": 8,
  "cpmIde.stopBits": 1,
  "cpmIde.parity": "none",
  "cpmIde.flowControl": "none",
  "cpmIde.enableSerialTrace": false,
  "cpmIde.forceCapitals": true,
  "cpmIde.textColor": "#cccccc",
  "cpmIde.terminalSize": "80x25",
  "cpmIde.assembler": "z80asm",
  "cpmIde.assemblerPath": "",
  "cpmIde.zasmFlags": "-b",
  "cpmIde.compiler": "cc",
  "cpmIde.makeCommand": ""
}
```

| Setting | Description |
| --- | --- |
| `cpmIde.serialPort` / `baudRate` / `dataBits` / `stopBits` / `parity` / `flowControl` | Serial connection parameters |
| `cpmIde.enableSerialTrace` | Logs every byte sent/received to the "CP/M IDE: Serial Trace" output channel - useful for diagnosing comms issues, noisy otherwise |
| `cpmIde.forceCapitals` | Converts typed input to uppercase in the terminal |
| `cpmIde.textColor` | Terminal output text color (also settable via the color picker next to "Force caps") |
| `cpmIde.terminalSize` | Fixed character grid for the terminal display; font size scales to fit it |

### Assembler Configuration

The extension supports multiple Z80 assemblers. Set `cpmIde.assembler` to one of:

- **z80asm** (default) - Syntax: `z80asm infile -o outfile`
- **zasm** - Syntax: `zasm [flags] infile outfile`
  - Configure ZASM flags with `cpmIde.zasmFlags` (default: `-b` for binary output)
  - Example with listing: `"cpmIde.zasmFlags": "-b -l"`
- **tasm** - Syntax: `tasm infile outfile`
- **other** - Provide full command path in `cpmIde.assemblerPath`

### C Compiler Configuration

The extension supports multiple C compilers. Set `cpmIde.compiler` to one of:

- **cc** (default) - Traditional CP/M C compiler
  - Generates object files (.o)
- **sdcc** - SDCC (Small Device C Compiler)
  - Generates .COM files directly
  - Set target architecture with `cpmIde.sdccTarget` (default: `z80`)
  - Supported targets: `z80`, `z180`, `r2k`, `r3ka`
  - Configure additional flags with `cpmIde.sdccFlags`
  - Example: `"cpmIde.sdccFlags": "--std-c99 --opt-code-size"`
- **other** - Provide full command path in `cpmIde.compilerPath`

### Make Integration

If a `Makefile`/`makefile` is found in the workspace root **and** `cpmIde.makeCommand` is set (e.g. `"make"` or `"mingw32-make -f Custom.mk"`), "Build CP/M Project" runs that instead of assembling/compiling files individually. Leave `makeCommand` empty to always use the per-file build.

## Usage

### Opening the Serial Terminal

1. Run command: "CP/M IDE: Open CP/M Serial Terminal" (or click the plug icon on the CP/M Files panel)
2. Configure port settings if needed
3. Once connected, the CP/M Files panel auto-scans drives and files, and the status line shows the port and (once detected) the device's CP/M version

### File Transfer

- **CP/M sidebar**: Use the CP/M IDE activity bar icon to open the "CP/M Files" and "Local Files" panels
- **To Device (local file area)**: Right-click any local file in Explorer, or use the inline icon in the Local Files panel → "Auto Send File"
- **From Device**: Click the inline download icon next to a remote file in the CP/M Files panel → "Auto Receive File"
- **Batch send**: Select multiple local files → "Send (Slide)" to transfer them all in one windowed transfer
- **Manual XMODEM**: "Manual Send (XMODEM)" / "Manual Receive (XMODEM)" bypass Remote CCP entirely, for diagnosing device-side issues
- **Upload flow**: Select the target drive (A:-P:); the extension ensures whichever helper program the chosen transfer method needs is present on that drive, copying it from `A:` via `PIP` first if not (prompting for confirmation the first time)

### Remote CCP

Remote CCP (`remote/remotccp.asm`, see `specs/Remote CCP Specification.md`) is a small resident CP/M program that answers short text commands over the same serial line used for interactive typing - selecting drives, listing files, and streaming file contents as hex-encoded blocks with per-block acknowledgement. It's the fastest and most reliable transfer path, used automatically once installed:

- On first use, if `REMOTCCP.COM` isn't found on `A:`, you're asked whether to install it there via `PIP` reading from `RDR:`
- Once present, it's used to scan drives/files (replacing the slower CCP `DIR`-driven scan) and for all automatic file transfers
- If it's ever unavailable or the install is declined, the extension transparently falls back to the CCP-command/XMODEM path - no functionality is lost, just some speed

### Building Projects

1. Create `.asm` or `.c` files in your workspace
2. Run command: "CP/M IDE: Build Project" (or use the inline Assemble/Compile icons on individual files in the Local Files panel)
3. Output files (`.COM`) are created alongside source files, or via your configured Makefile

## Architecture

### Core Modules

- **extension.ts** - Main extension entry point, command registration, and connection-status UI
- **serialTerminal.ts** - Serial port management, terminal integration, and orchestration of the Remote CCP/XMODEM/Slide transfer paths
- **serialTerminalPanel.ts** - Webview host for the interactive terminal panel
- **remoteCcp.ts** - Client for the Remote CCP protocol (drive/file listing, get/put)
- **xmodem.ts** - XMODEM protocol implementation (128-byte checksum variant) and the shared `SerialLink` abstraction used by all transfer protocols
- **slide-ts/** - Windowed, CRC16, multi-file Slide transfer protocol (`protocol.ts`, `send.ts`, `recv.ts`)
- **fileExplorer.ts** - Tree view providers for the remote CP/M files and local workspace files
- **build.ts** - Build system integration for the assembler, compiler, and Makefile-driven builds
- **remote/remotccp.asm** - The Z80 assembly source for the on-device Remote CCP helper (assembled to `remote/remotccp.com`, bundled with the extension)
- **media/** - Webview UI for the terminal panel (`terminal.html`/`.js`/`.css`)

## File Transfer Protocols

Three transfer paths are available, in order of preference:

1. **Remote CCP** - custom command/response protocol purpose-built for this extension; fastest, with explicit ACKs around real disk I/O (drive selects, file creation/writes) instead of guessed delays. Requires `REMOTCCP.COM` on the device (auto-installed on request).
2. **XMODEM** - standard 128-byte checksum XMODEM, used automatically when Remote CCP is unavailable, and directly via the manual send/receive commands. Requires `XMODEM.COM` on the device (auto-copied from `A:` via `PIP` when needed).
3. **Slide** - a sliding-window (4 frames in flight), 1024-byte-frame, CRC16 protocol for sending multiple files in a single batch. Requires `SLIDECPM.COM` on the device.

All directory operations and file transfers are performed transparently, with command output hidden from the interactive terminal unless explicitly requested (e.g. via `cpmIde.enableSerialTrace`).

## Requirements

- VS Code 1.80.0 or later
- Node.js 18+ recommended for development and publishing
- Serial port connection to a CP/M device
- Z80 assembler (z80asm, TASM, zasm, etc.) for assembly builds
- C compiler (compatible with CP/M targets) for C builds

## Known Limitations

- XMODEM-CRC variant not yet implemented (checksum-only XMODEM)
- Remote CCP requires installing a small resident helper on the device; some very constrained BIOS/BDOS builds may behave unexpectedly under its automated disk-select/file-create sequencing
- No integrated debugger (uses CP/M native debugging tools)

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Run tests
npm run test

# Create .vsix package
npx @vscode/vsce package

# Publish to the Marketplace
npx @vscode/vsce publish patch
```

## Publishing

This extension is configured in [package.json](package.json) with the name `cpm-ide` and publisher `rockcat`, so the Marketplace identifier is `rockcat.cpm-ide` unless you change one of those fields.

Before publishing, run the full validation flow:

1. `npm install`
2. `npm run compile`
3. `npm run test`
4. `npx @vscode/vsce package`
5. `npx @vscode/vsce publish patch`

## License

See [LICENSE.txt](LICENSE.txt).

## Contributing

Contributions welcome! Please follow the coding standards and test before submitting pull requests.

## Roadmap

- [ ] XMODEM-CRC support
- [ ] Remote file editing
- [ ] Integrated CP/M debugger
- [ ] Source-level debugging support
- [ ] Project templates
