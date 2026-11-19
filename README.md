# Infinite Canvas MCP — Stage 1

TypeScript domain engine for stage-based project learning, infinite-canvas placement,
validated cross-project experience, and AI handoff. The implementation follows
[ARCHITECTURE.md](ARCHITECTURE.md). MCP/HTTP/SSE adapters and the visual workbench
belong to Stages 2 and 3.

## Run

Requires Node.js 22 or newer and npm.

```sh
npm install
npm test
npm run typecheck
npm run build
npm start
```

`npm start` initializes the local store, prints a short inventory, and exits.
On first boot it creates `data/store.json` and one
`data/handoffs/HANDOFF-<canvasId>.md` per canvas. The illustrative demo contains two
groups, an active project with stages 1 and 2 consolidated and stage 3 in progress,
and a completed project with final practices and reusable experiences. Demo history
illustrates the domain model; it is not a claim that Stage 2/3 services are implemented.
An existing store, including an empty store, is never reseeded. Runtime data is ignored
by Git; fixture generation lives in `createDemoStore()`.

## Core API

Import `CanvasEngine` from `src/core/engine.ts` (use `.js` imports in NodeNext
TypeScript source). All methods are synchronous and return detached snapshots.
Omitting `canvasId` selects the persisted active canvas.

```ts
import { CanvasEngine } from './src/core/engine.js';

const engine = new CanvasEngine({ dataDir: './my-project-data', seedDemo: false });
const group = engine.createGroup({ name: 'Engineering' });
const canvas = engine.createCanvas({
  groupId: group.id,
  title: 'Release service',
  projectKey: 'release-service',
  description: 'Reliable release orchestration',
});

engine.recordLearning({
  title: 'Agreed service boundary convention',
  content: 'Validate every request before invoking domain logic.',
  tags: ['validation'],
  relatedFiles: ['src/contracts.ts'],
  importance: 5,
  validated: true,
});
engine.consolidateStage(canvas.id, {
  advanceToNextStage: true,
  nextStageTitle: 'Recovery validation',
});
const pending = engine.recordLearning({
  title: 'Recovery drill',
  content: 'Verify recovery after an interrupted state write.',
  category: 'best_practice',
  status: 'open',
});
// After the project actually validates this finding:
engine.updateLearning(pending.id, { status: 'active', validated: true });
engine.finalizeProjectDistillation(canvas.id);
const handoff = engine.getHandoffContext(canvas.id); // structured JSON + .markdown

const successor = engine.createCanvas({ groupId: group.id, title: 'Next service', projectKey: 'next-service' });
const experiences = engine.queryCrossProjectExperiences({ query: 'validation', tags: ['validation'] });
if (experiences[0]) engine.applyExperienceToCanvas(experiences[0].id, successor.id);
```

| Operation | Signature |
| --- | --- |
| Groups | `createGroup(input)`, `listGroups()`, `updateGroup(groupId, patch)` |
| Canvases | `createCanvas(input)`, `listCanvases(groupId?)`, `getCanvas(canvasId?)`, `switchCanvas(canvasId)` |
| Learning | `recordLearning(input, canvasId?)`, `updateLearning(nodeId, review, canvasId?)` |
| Checkpoint | `consolidateStage(canvasId?, { advanceToNextStage?, nextStageTitle? })` |
| Advance | `advanceStage(canvasId?, title?)` |
| Finalize | `finalizeProjectDistillation(canvasId?, { validatedNodeIds?, summary? })` |
| Handoff | `getHandoffContext(canvasId?)` |
| Search | `queryCrossProjectExperiences({ query?, category?, tags?, excludeCanvasId?, limit? })` |
| Import | `applyExperienceToCanvas(experienceId, canvasId?)` |

Input and domain types plus Zod schemas are exported from `src/types/schema.ts`.
`importance` is an integer from 1 to 5 (default 3). Node statuses are `active`,
`open`, and `superseded`; validation is a separate boolean, defaulting to false.

## Domain behavior

- Classification uses deterministic English/Chinese title, content, and tag rules.
  Explicit categories take precedence. Summary bullets are extracted from the
  original text; reusable candidates are suggestions, not validation evidence.
  Ambiguous language can require an explicit category; this engine does not call an LLM.
- Stage X positions are `(stageNumber - 1) * 1500`. Five ordered vertical containers
  grow downward to fit three-column card grids. All geometry is in `bounds` and uses
  absolute world coordinates. Final cards have their own zone to the right and keep
  source references to the original cards.
- Duplicate learning with the same normalized title/content/category/status in a
  stage merges tags, files, validation, and importance. Consolidation creates one
  summary per populated category, preserving original records and evidence edges.
  Repeating a checkpoint without advancement is idempotent. Checkpoints are historical
  snapshots; later review updates the original evidence and future distillation.
- Explicit advancement first consolidates the current stage. A consolidated stage
  rejects additional learning until advancement. New canvases become active;
  switching canvases is persisted. Project keys are unique across groups.
- Finalization publishes active, explicitly validated conventions and best practices,
  plus validated architecture, implementations, and fixes with importance 4 or 5.
  Open, superseded, and unvalidated records remain visible in the handoff but are
  excluded from reusable experience. `validatedNodeIds` explicitly confirms selected
  active originals before finalization. Fixes become validated best-practice guidance.
  Equivalent findings across stages share an experience with all source IDs retained.
  Repeated finalization is idempotent; completed canvases reject further edits.
- Imported implementation/architecture experience goes to the architecture cluster;
  other experience goes to conventions. Importing the same experience twice returns
  the existing card. Source-project paths remain in provenance, rather than being
  attached as target-project files. Imported guidance requires validation in its new
  context before it can be republished.
- Search combines case-insensitive keyword matching (all words), category filtering,
  and tag filtering (all tags), ranking title matches first. The default limit is 100.
- Handoffs include project background, conventions, historical category checkpoints,
  implementation/architecture indices, unresolved items, final practices, imported
  provenance, every original record, and evolution links. Generated timestamps are
  based on project/group updates so JSON and file mirrors agree.

## Persistence and recovery

Every write reloads and validates the latest store under an exclusive filesystem
lock, then writes a same-directory temporary file, flushes it, and atomically renames
it over `store.json`. Invalid mutations leave the existing snapshot unchanged.
The lock prevents conflicting writers; a competing process receives an explicit
retryable error. After a process crash, remove `data/store.lock` only after confirming
its writer is no longer running. Corrupt stores fail loudly and are never reseeded.

Markdown is derived from JSON and refreshed after each mutation. JSON and all Markdown
files cannot be committed as one filesystem transaction: a mirror-write failure reports
that JSON was committed. Fix the filesystem issue and restart the engine to regenerate
missing or stale mirrors. The synchronous, whole-store design targets local project
knowledge stores; larger deployments can replace the storage adapter in a later stage.

## Verification

`tests/engine.test.ts` uses Node's built-in runner through
`node --import tsx --test`. It exercises all Stage 1 operations, bilingual classification,
geometry containment and overlap, provenance, validation gates, idempotency, persistence
across engine instances, corrupt-store protection, and handoff recovery. Tests use isolated
temporary directories and do not modify the working demo store.
