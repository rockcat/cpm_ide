import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class BuildManager {
	private buildChannel: vscode.OutputChannel;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.buildChannel = vscode.window.createOutputChannel('CP/M Build');
	}

	async buildProject(): Promise<boolean> {
		this.buildChannel.clear();
		this.buildChannel.show();

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			this.buildChannel.appendLine('Error: No workspace folder open');
			return false;
		}

		const settings = vscode.workspace.getConfiguration('cpmIde');
		const assembler = settings.get<string>('assembler') || 'z80asm';
		const compiler = settings.get<string>('compiler') || 'cc';

		try {
			// Find source files
			const asmFiles = await this.findFiles(workspaceFolder.uri.fsPath, '.asm');
			const cFiles = await this.findFiles(workspaceFolder.uri.fsPath, '.c');

			this.buildChannel.appendLine('CP/M Build Started');
			this.buildChannel.appendLine(`Workspace: ${workspaceFolder.uri.fsPath}`);
			this.buildChannel.appendLine('');

			// Build assembly files
			for (const asmFile of asmFiles) {
				await this.buildAssemblyFile(asmFile, assembler, workspaceFolder.uri.fsPath);
			}

			// Build C files
			for (const cFile of cFiles) {
				await this.buildCFile(cFile, compiler, workspaceFolder.uri.fsPath);
			}

			this.buildChannel.appendLine('');
			this.buildChannel.appendLine('Build completed successfully');
			vscode.window.showInformationMessage('CP/M build completed');
			return true;
		} catch (error) {
			this.buildChannel.appendLine(`Build failed: ${error}`);
			vscode.window.showErrorMessage(`Build failed: ${error}`);
			return false;
		}
	}

	private async buildAssemblyFile(asmFile: string, assembler: string, workspaceDir: string): Promise<void> {
		const fileName = path.basename(asmFile);
		const outputName = path.basename(asmFile, '.asm') + '.com';
		const outputPath = path.join(path.dirname(asmFile), outputName);

		this.buildChannel.appendLine(`Assembling ${fileName} with ${assembler}...`);

		return new Promise((resolve, reject) => {
			let cmd: string;
			const settings = vscode.workspace.getConfiguration('cpmIde');

			if (assembler === 'zasm') {
				// ZASM syntax: zasm [flags] infile [outfile]
				const zasmFlags = settings.get<string>('zasmFlags') || '-b';
				cmd = `zasm ${zasmFlags} "${asmFile}" "${outputPath}"`;
			} else if (assembler === 'tasm') {
				// TASM syntax: tasm infile [outfile] [flags]
				cmd = `tasm "${asmFile}" "${outputPath}"`;
			} else {
				// Default z80asm syntax: z80asm [options] infile -o outfile
				cmd = `${assembler} "${asmFile}" -o "${outputPath}"`;
			}

			this.buildChannel.appendLine(`Command: ${cmd}`);

			cp.exec(cmd, { cwd: workspaceDir }, (error, stdout, stderr) => {
				if (stdout) {
					this.buildChannel.appendLine(stdout);
				}
				if (stderr) {
					this.buildChannel.appendLine(stderr);
				}

				if (error) {
					reject(error);
				} else {
					this.buildChannel.appendLine(`✓ Generated ${outputName}`);
					resolve();
				}
			});
		});
	}

	private async buildCFile(cFile: string, compiler: string, workspaceDir: string): Promise<void> {
		const fileName = path.basename(cFile);
		const comName = path.basename(cFile, '.c') + '.com';
		const comPath = path.join(path.dirname(cFile), comName);
		const objName = path.basename(cFile, '.c') + '.o';
		const objPath = path.join(path.dirname(cFile), objName);

		this.buildChannel.appendLine(`Compiling ${fileName} with ${compiler}...`);

		return new Promise((resolve, reject) => {
			let cmd: string;
			const settings = vscode.workspace.getConfiguration('cpmIde');

			if (compiler === 'sdcc') {
				// SDCC syntax: sdcc -m[target] [flags] -o outfile infile
				const target = settings.get<string>('sdccTarget') || 'z80';
				const sdccFlags = settings.get<string>('sdccFlags') || '';
				cmd = `sdcc -m${target} ${sdccFlags} -o "${comPath}" "${cFile}"`.trim();
			} else {
				// Default cc syntax: cc -c infile -o outfile
				cmd = `${compiler} -c "${cFile}" -o "${objPath}"`;
			}

			this.buildChannel.appendLine(`Command: ${cmd}`);

			cp.exec(cmd, { cwd: workspaceDir }, (error, stdout, stderr) => {
				if (stdout) {
					this.buildChannel.appendLine(stdout);
				}
				if (stderr) {
					this.buildChannel.appendLine(stderr);
				}

				if (error) {
					reject(error);
				} else {
					const outputName = compiler === 'sdcc' ? comName : objName;
					this.buildChannel.appendLine(`✓ Generated ${outputName}`);
					resolve();
				}
			});
		});
	}

	private async findFiles(dir: string, extension: string): Promise<string[]> {
		const files: string[] = [];

		const recursiveFind = (currentDir: string) => {
			try {
				const items = fs.readdirSync(currentDir);
				for (const item of items) {
					const fullPath = path.join(currentDir, item);
					const stat = fs.statSync(fullPath);

					if (stat.isDirectory()) {
						if (!item.startsWith('.') && item !== 'node_modules') {
							recursiveFind(fullPath);
						}
					} else if (item.endsWith(extension)) {
						files.push(fullPath);
					}
				}
			} catch (error) {
				// Ignore read errors
			}
		};

		recursiveFind(dir);
		return files;
	}
}
