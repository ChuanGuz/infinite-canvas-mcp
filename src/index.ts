import { CanvasEngine } from './core/engine.js';

const engine = new CanvasEngine();
console.log(`Store ready: ${engine.storage.storePath}`);
console.log(`${engine.listGroups().length} groups; ${engine.listCanvases().length} canvases; ${engine.queryCrossProjectExperiences().length} reusable experiences.`);
console.log(`Handoffs: ${engine.storage.handoffDir}`);
