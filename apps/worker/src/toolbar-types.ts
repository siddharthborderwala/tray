// Shared by the toolbar (toolbar-client.ts, in the page) and the Worker.

export interface ToolbarConfig {
  /** Where to fetch who's signed in (`ToolbarMe`). */
  me: string;
  font: string;
  signout: string;
  /** The `tray.` wordmark, as SVG markup (our own constant, not user data). */
  mark: string;
}

export interface ToolbarMe {
  email: string;
  role: "owner" | "viewer";
  site: string;
  host: string;
  visibility: "public" | "private";
  owner: string;
  /** Owner only: emails and `@domain`s with access, besides the owner. */
  sharedWith?: string[];
}
