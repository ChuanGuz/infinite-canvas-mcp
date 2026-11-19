import { runHttpServer } from './server/app.js';

runHttpServer().catch(error => { console.error(error); process.exitCode = 1; });
