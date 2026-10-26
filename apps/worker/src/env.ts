// Worker bindings and the small slice of the R2 binding API that Tray uses.
// (Declared here instead of pulling in @cloudflare/workers-types, whose
// globals clash with Bun's in this workspace.)

export interface Env {
  BUCKET: R2Bucket;
  /** The tray's domain, e.g. `acme.dev`. API lives at `tray.<DOMAIN>`, sites at `<site>.<DOMAIN>`. */
  DOMAIN: string;
  /** Only this email may approve logins through `/approve`. Optional (Access already restricts it). */
  OWNER_EMAIL?: string;
  /** Zero Trust team, e.g. `acme` or `acme.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** AUD tag of the owner Access app on `tray.<DOMAIN>/approve`. */
  ACCESS_APPROVE_AUD?: string;
  /** AUD tag of the sign-in Access app on `*.<DOMAIN>/.tray/signin` (+ custom hosts). */
  ACCESS_SIGNIN_AUD?: string;
  /** App id of that sign-in Access app (custom hosts are added to it). */
  ACCESS_SIGNIN_APP_ID?: string;
  /** Cloudflare account id and API token, for custom domains. */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** This Worker's script name (custom domains point at it). Default `tray`. */
  WORKER_NAME?: string;
  /**
   * Secret set by `tray setup`: the KeyRecord JSON (hash only) of the key it
   * minted for the machine running setup. Accepted once, then moved to R2, so
   * setup never has to write to R2 itself and recovery works with all keys lost.
   */
  TRAY_SETUP_KEY?: string;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptions {
  /** Hex digest; R2 rejects the put if the body doesn't match. */
  sha256?: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

export interface R2ListOptions {
  prefix?: string;
  delimiter?: string;
  cursor?: string;
  limit?: number;
  startAfter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

export interface R2Objects {
  objects: R2Object[];
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

/** `fetch` without Bun's extras, so tests can pass a plain function. */
export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
