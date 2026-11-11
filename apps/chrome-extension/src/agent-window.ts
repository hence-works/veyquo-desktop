// The agent's own place in the person's everyday Chrome (desktop plan §4.3): one Veyquo
// window, opened without focus, whose tabs sit in a tab group named "Veyquo". The agent's tab
// is the active tab of that window (a background tab is `document.hidden`: Chrome would stop
// painting it, which stalls the live view and page timers), and the window is never focused
// or minimised, so the person's own window stays in front.
//
// Visibility: an extension cannot move a window off every display (Chrome keeps windows
// on-screen), so "visible" and "background" both mean an unfocused Veyquo window here. The
// person's own window keeps focus either way.

const groupTitle = 'Veyquo';

export class AgentWindow {
  private windowId: number | null = null;
  private groupId: number | null = null;

  constructor() {
    chrome.windows.onRemoved.addListener((windowId) => {
      if (windowId === this.windowId) {
        this.windowId = null;
        this.groupId = null;
      }
    });
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (group.id === this.groupId) this.groupId = null;
    });
  }

  async openTab(): Promise<number> {
    const windowId = await this.existingWindow();
    let tabId: number | undefined;
    let inWindow: number;
    if (windowId === null) {
      const created = await chrome.windows.create({
        url: 'about:blank',
        focused: false,
        type: 'normal',
        state: 'normal',
      });
      inWindow = created?.id ?? chrome.windows.WINDOW_ID_NONE;
      tabId = created?.tabs?.[0]?.id;
      this.windowId = inWindow;
    } else {
      inWindow = windowId;
      tabId = (await chrome.tabs.create({ windowId, url: 'about:blank', active: true })).id;
    }
    if (tabId === undefined) throw new Error('Chrome opened no tab');
    await this.group(tabId, inWindow).catch(() => undefined); // the group is a courtesy
    return tabId;
  }

  private async existingWindow(): Promise<number | null> {
    if (this.windowId === null) return null;
    try {
      await chrome.windows.get(this.windowId);
      return this.windowId;
    } catch {
      this.windowId = null;
      this.groupId = null;
      return null;
    }
  }

  private async group(tabId: number, windowId: number): Promise<void> {
    if (this.groupId !== null) {
      try {
        await chrome.tabs.group({ groupId: this.groupId, tabIds: [tabId] });
        return;
      } catch {
        this.groupId = null;
      }
    }
    this.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(this.groupId, { title: groupTitle, color: 'blue' });
  }
}
