import { CATEGORY_ORDER } from '../types/schema.js';
import type { Bounds, Canvas, CanvasNode } from '../types/schema.js';

export const STAGE_SPACING = 1500;
export const STAGE_WIDTH = 1400;
const PADDING = 32;
const GAP = 24;
const CARD_WIDTH = 416;
const COLUMNS = 3;

export const initialBounds = (): Bounds => ({ x: 0, y: 0, width: 1, height: 1 });

function cardHeight(node: CanvasNode): number {
  const lines = node.summaryBullets.reduce((sum, bullet) => sum + Math.ceil([...bullet].length / 36), 0);
  return Math.max(200, 104 + Math.ceil([...node.title].length / 32) * 26 + lines * 22);
}

function placeGrid(nodes: CanvasNode[], x: number, y: number): number {
  let cursorY = y;
  for (let i = 0; i < nodes.length; i += COLUMNS) {
    const row = nodes.slice(i, i + COLUMNS);
    const rowHeight = Math.max(...row.map(cardHeight));
    row.forEach((node, column) => {
      node.bounds = { x: x + column * (CARD_WIDTH + GAP), y: cursorY, width: CARD_WIDTH, height: cardHeight(node) };
    });
    cursorY += rowHeight + GAP;
  }
  return nodes.length ? cursorY - y - GAP : 0;
}

/** Reflow the entire canvas deterministically; containers grow downward, never sideways. */
export function layoutCanvas(canvas: Canvas): Canvas {
  canvas.stages.sort((a, b) => a.stageNumber - b.stageNumber);
  for (const stage of canvas.stages) {
    const x = (stage.stageNumber - 1) * STAGE_SPACING;
    let y = 96;
    for (const category of CATEGORY_ORDER) {
      const cluster = stage.clusters[category];
      const nodes = canvas.nodes.filter(n => n.zone === 'stage' && n.stageNumber === stage.stageNumber && n.category === category)
        .sort((a, b) => Number(b.kind === 'stage_summary') - Number(a.kind === 'stage_summary') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      cluster.nodeIds = nodes.map(n => n.id);
      cluster.summaryNodeId = nodes.find(n => n.kind === 'stage_summary')?.id ?? null;
      const height = Math.max(120, 68 + placeGrid(nodes, x + PADDING * 2, y + 68) + PADDING);
      cluster.bounds = { x: x + PADDING, y, width: STAGE_WIDTH - PADDING * 2, height };
      y += height + GAP;
    }
    stage.bounds = { x, y: 0, width: STAGE_WIDTH, height: y + PADDING };
  }
  if (canvas.finalZone) {
    const x = Math.max(...canvas.stages.map(s => s.stageNumber)) * STAGE_SPACING;
    const nodes = canvas.nodes.filter(n => n.zone === 'final');
    canvas.finalZone.bounds = {
      x, y: 0, width: STAGE_WIDTH,
      height: Math.max(240, 100 + placeGrid(nodes, x + PADDING, 100) + PADDING),
    };
  }
  return canvas;
}
