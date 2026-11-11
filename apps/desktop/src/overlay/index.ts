import type { AgentOverlayUpdate } from '../shared/agent-overlay.ts';

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error('agent overlay surface is incomplete');
  return element;
}

requiredElement('#control');
const cursor = requiredElement('#agent-cursor');

let fade: ReturnType<typeof setTimeout> | null = null;

function apply(update: AgentOverlayUpdate): void {
  if (update.kind === 'activity') {
    document.body.dataset.active = String(update.visible);
    if (!update.visible) {
      cursor.dataset.visible = 'false';
      if (fade !== null) clearTimeout(fade);
      fade = null;
    }
    return;
  }
  cursor.dataset.edgeX = update.x > window.innerWidth - 112 ? 'right' : 'left';
  cursor.dataset.edgeY = update.y > window.innerHeight - 44 ? 'bottom' : 'top';
  cursor.style.transform = `translate(${String(Math.round(update.x))}px, ${String(Math.round(update.y))}px)`;
  cursor.dataset.visible = 'true';
  cursor.dataset.action = update.action;
  cursor.dataset.sequence = String(update.sequence);
  if (fade !== null) clearTimeout(fade);
  fade = setTimeout(() => {
    cursor.dataset.visible = 'false';
    fade = null;
  }, 2_000);
}

window.veyquoAgentOverlay.onUpdate(apply);
