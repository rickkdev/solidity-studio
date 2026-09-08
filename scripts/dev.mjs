import { spawn } from 'node:child_process';
import { startStudioServer } from '../packages/cli/dist/studio-server.js';
const studio = await startStudioServer({ port: Number(process.env.CODEVIS_STUDIO_PORT ?? 4174) });
console.log(`Solidity compiler: ${studio.url}`);
const vite = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', process.env.CODEVIS_WEB_PORT ?? '5173', '--strictPort'], { cwd: 'apps/web', stdio: 'inherit' });
// Resolve Vite from the root workspace rather than depending on hoisting within apps/web.
vite.on('error', async error => { console.error(error); await studio.close(); process.exitCode = 1; });
vite.on('exit', async code => { await studio.close(); process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => vite.kill(signal));
