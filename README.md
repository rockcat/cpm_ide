# CP/M IDE

A VS Code extension for CP/M application development with integrated serial terminal and file transfer capabilities.

## Features

### 🔌 Integrated Serial Terminal
- Configurable serial connection with baud rate, data bits, and parity settings
- Automatic detection of CP/M command prompts (A>, B>, etc.)
- Transparent background command execution for device management

### 📁 File Transfer System
- Automatic scanning of CP/M drives on connection
- XMODEM protocol implementation for reliable file transfer
- One-click file transfer to/from remote device
- Integrated file explorer showing remote CP/M drives and files
- Automatic installation of XMODEM.COM utility

### 🖥️ Z80 Assembly Support
- Complete Z80 assembly syntax highlighting
- Support for various assembly syntaxes and directives
- Mnemonics highlighting for all standard Z80 instructions
- Numeric format support (hex, binary, decimal, octal)

### 🔨 Build Integration
- Support for local Z80 assembler integration
- C compiler integration for building .COM files
- Configurable build tools via settings
- Build output captured in dedicated channel

## Installation

1. Clone or download this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Package the extension: `vsce package`
5. Install in VS Code or use `F5` to debug

## Configuration

Configure the extension via VS Code settings:

```json
{
  "cpmIde.serialPort": "COM1",
  "cpmIde.baudRate": 9600,
  "cpmIde.dataBits": 8,
  "cpmIde.stopBits": 1,
  "cpmIde.parity": "none",
  "cpmIde.assembler": "z80asm",
  "cpmIde.assemblerPath": "",
  "cpmIde.zasmFlags": "-b",
  "cpmIde.compiler": "cc"
}
```

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

## Usage

### Opening the Serial Terminal
1. Run command: "Open CP/M Serial Terminal"
2. Configure port settings if needed
3. The extension will auto-detect CP/M drives and files

### File Transfer
- **To Device**: Right-click file in explorer → "Transfer File to CP/M Device"
- **From Device**: Click transfer icon next to file in CP/M Files panel

### Building Projects
1. Create .asm or .c files in your workspace
2. Run command: "Build CP/M Project"
3. Output files (.COM) are created alongside source files

## Architecture

### Core Modules

- **extension.ts** - Main extension entry point and command registration
- **serialTerminal.ts** - Serial port management and terminal integration
- **xmodem.ts** - XMODEM protocol implementation (128-byte and 1K variants)
- **fileExplorer.ts** - Tree view provider for remote CP/M files
- **build.ts** - Build system integration for assembler and compiler

## Serial Protocol

The extension uses CP/M 2.2 standard commands for file management:

- Drive selection: `A:`, `B:`, etc.
- Directory listing: `DIR`
- File transfer: XMODEM protocol via `XMODEM.COM`

All directory operations and file transfers are performed transparently, with command output hidden from the user unless explicitly requested.

## Requirements

- VS Code 1.80.0 or later
- Node.js 14+ for development
- Serial port connection to CP/M device
- Z80 assembler (z80asm, TASM, etc.) for assembly builds
- C compiler (compatible with CP/M targets) for C builds

## Known Limitations

- XMODEM-CRC variant not yet implemented (uses checksum only)
- Batch file operations not yet supported
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
npx vsce package
```

## License

MIT

## Contributing

Contributions welcome! Please follow the coding standards and test before submitting pull requests.

## Roadmap

- [ ] XMODEM-CRC support
- [ ] Batch file operations
- [ ] Remote file editing
- [ ] Integrated CP/M debugger
- [ ] Source-level debugging support
- [ ] Make file integration
- [ ] Project templates
