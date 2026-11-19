import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const result = spawnSync(compiler, ['-nologo', '-target:winexe', '-platform:x64', '-codepage:65001',
  '-reference:System.Windows.Forms.dll', '-reference:System.Drawing.dll',
  `-out:${resolve('无限画布.exe')}`, resolve('src/desktop/Launcher.cs')], { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error('无法编译桌面启动器：', result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
