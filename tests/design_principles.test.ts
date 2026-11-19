import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CanvasEngine, createDemoStore } from '../src/core/engine.js';
import { CORE_CONVENTIONS } from '../src/core/storage.js';

test('core conventions have original evidence, maximum importance and reusable best practices', () => {
  const store = createDemoStore();
  const canvas = store.canvases.find(c => c.id === store.activeCanvasId)!;
  assert.equal(canvas.status, 'active');
  assert.equal(canvas.finalZone, null, 'Publishing confirmed conventions must not finalize the project');
  for (const input of CORE_CONVENTIONS) {
    const node = canvas.nodes.find(n => n.title === input.title)!;
    assert.equal(node.content, input.content);
    assert.equal(node.category, 'convention_practice');
    assert.equal(node.importance, 5);
    assert.equal(node.validated, true);
    const experience = store.crossProjectExperiences.find(e => e.title === input.title)!;
    assert.equal(experience.category, 'best_practice');
    assert.equal(experience.content, input.content);
    assert.equal(experience.sourceCanvasId, canvas.id);
    assert.deepEqual(experience.sourceNodeIds, [node.id]);
  }
});

test('dogfooding update preserves existing data, regenerates handoffs and is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-principles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Build a pre-update project while retaining other demo data and identities.
  const initial = new CanvasEngine({ dataDir: dir, seedDemo: false });
  const group = initial.createGroup({ name: '我的项目' });
  const canvas = initial.createCanvas({ groupId: group.id, title: '无限画布知识工作台', projectKey: 'my-project' });
  const original = initial.recordLearning({ title: '保留已有证据', content: '不能重置我的数据。' });
  initial.consolidateStage();
  const checkpoint = initial.getCanvas().nodes.find(n => n.id === original.id);
  const run = () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/record-design-principles.ts'), dir],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run();
  const updated = new CanvasEngine({ dataDir: dir });
  assert.equal(updated.getCanvas().id, canvas.id);
  assert.equal(updated.getCanvas().currentStageNumber, 2);
  assert.deepEqual(updated.getCanvas().nodes.find(n => n.id === original.id), checkpoint);
  for (const input of CORE_CONVENTIONS) {
    assert.ok(updated.getHandoffContext().markdown.includes(input.content));
    assert.equal(updated.queryCrossProjectExperiences({ query: input.title, category: 'best_practice' }).length, 1);
  }
  const before = readFileSync(updated.storage.storePath, 'utf8');
  const handoffPath = join(dir, 'handoffs', `HANDOFF-${canvas.id}.md`);
  const handoff = readFileSync(handoffPath, 'utf8');
  writeFileSync(handoffPath, 'stale');
  run();
  assert.equal(readFileSync(updated.storage.storePath, 'utf8'), before);
  assert.equal(readFileSync(handoffPath, 'utf8'), handoff);
});
