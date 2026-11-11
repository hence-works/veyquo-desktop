// Which tabs Veyquo may use in the person's everyday Chrome (desktop plan §4.3), checked here
// in the extension whatever the app asks:
//
// - an agent tab (one the extension opened for the agent, in the Veyquo window) is the
//   agent's until it closes;
// - any other tab only after the person approved that tab ("Let Veyquo use this tab"), for
//   the web origin it showed then. The grant ends when the tab closes, when its page leaves
//   that origin (a later return does not bring it back), when the person takes it back, or
//   when the attempt using it ends (the app revokes it).
//
// Only http(s) pages can be approved: never a browser page, another extension or a file.

export type TabPermit = 'agent' | 'granted';

function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export class TabPermissions {
  private readonly agent = new Set<number>();
  /** Granted tab id -> the origin it was approved on. */
  private readonly granted = new Map<number, string>();

  addAgentTab(tabId: number): void {
    this.granted.delete(tabId);
    this.agent.add(tabId);
  }

  /** The person approved `tabId` while it showed `url`. False when it cannot be approved. */
  grant(tabId: number, url: string): boolean {
    if (this.agent.has(tabId)) return false;
    const origin = webOrigin(url);
    if (origin === null) return false;
    this.granted.set(tabId, origin);
    return true;
  }

  /** The person or the app ended a grant. False when there was none. */
  revoke(tabId: number): boolean {
    return this.granted.delete(tabId);
  }

  /** The tab closed: whatever Veyquo had of it ends. */
  closed(tabId: number): TabPermit | null {
    if (this.agent.delete(tabId)) return 'agent';
    if (this.granted.delete(tabId)) return 'granted';
    return null;
  }

  /** The tab now shows `url`. `ended`: a grant ended because the tab left its origin. */
  navigated(tabId: number, url: string): 'kept' | 'ended' | 'none' {
    if (this.agent.has(tabId)) return 'kept';
    const origin = this.granted.get(tabId);
    if (origin === undefined) return 'none';
    if (webOrigin(url) === origin) return 'kept';
    this.granted.delete(tabId);
    return 'ended';
  }

  permit(tabId: number): TabPermit | null {
    if (this.agent.has(tabId)) return 'agent';
    return this.granted.has(tabId) ? 'granted' : null;
  }

  allows(tabId: number): boolean {
    return this.permit(tabId) !== null;
  }

  /** The app went away: nothing it was given survives. */
  clear(): void {
    this.agent.clear();
    this.granted.clear();
  }
}
