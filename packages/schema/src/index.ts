// Shared zod schemas for the Tray Worker API v1 (SPEC.md §5).
//
// Used by the Worker (validation + OpenAPI output) and the CLI (parsing
// responses). `.meta({ id })` names a schema as an OpenAPI component.
//
// Response objects are plain `z.object`s, which strip unknown keys when
// parsing, so additive Worker changes don't break older CLIs.
import * as z from "zod";
import { Hostname, ShareEntry } from "./hosts.ts";

// ---------------------------------------------------------------------------
// Limits and primitives

export const SITE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const RESERVED_SITE_NAMES: readonly string[] = ["tray"];
/** 50 MB total per deploy (and per blob). */
export const MAX_DEPLOY_BYTES = 50 * 1024 * 1024;
/** Max hashes per `POST /blobs/check`. */
export const CHECK_BATCH_SIZE = 512;
export const API_KEY_PREFIX = "tray_k_";
/** Device codes expire after 10 minutes. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** Seconds between `POST /auth/token` polls. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

export const SiteName = z
  .string()
  .regex(SITE_NAME_RE, "invalid site name")
  .refine((s) => !RESERVED_SITE_NAMES.includes(s), "reserved site name");

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase sha256 hex digest");

export const Visibility = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof Visibility>;

export * from "./hosts.ts";

export const Email = z.email();

/** Deploy ids: base36 time + hex suffix, e.g. `mh7q2k1c-8f1a`. */
export const DeployId = z
  .string()
  .max(40)
  .regex(/^[0-9a-z]+-[0-9a-f]+$/, "expected a deploy id like mh7q2k1c-8f1a");

/** Key ids are the first 12 hex chars of sha256(key). */
export const KeyId = z.string().regex(/^[a-f0-9]{12}$/, "expected a 12-char key id");

/** e.g. `QXFT-7K2M`. Case-insensitive; the dash is optional on input. */
export const UserCode = z.string().min(8).max(9);

// ---------------------------------------------------------------------------
// Errors: every endpoint returns this shape on failure.

export const ErrorCode = z.enum([
  "invalid_request",
  "digest_mismatch",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "unauthenticated",
  "forbidden",
  "not_found",
  "site_not_found",
  "deploy_not_found",
  "domain_not_found",
  "key_not_found",
  "site_exists",
  "domain_taken",
  "missing_blobs",
  "site_public",
  "length_required",
  "too_large",
  "zone_not_in_account",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z
  .looseObject({
    error: z.string(),
    // Kept open (string) so new server codes don't break older CLIs.
    code: z.string(),
    hint: z.string().optional(),
    /** The bad field on validation errors. */
    param: z.string().optional(),
    /** `missing_blobs` only. */
    missing: z.array(z.string()).optional(),
  })
  .meta({ id: "Error" });
export type ApiError = z.infer<typeof ApiError>;

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

// ---------------------------------------------------------------------------
// Blobs

export const CheckBlobsRequest = z.object({ hashes: z.array(Sha256).max(CHECK_BATCH_SIZE) });
export const CheckBlobsResponse = z.object({ missing: z.array(Sha256) });
export const Blob = z
  .object({ hash: Sha256, size: z.number().int().nonnegative() })
  .meta({ id: "Blob" });
export type Blob = z.infer<typeof Blob>;

// ---------------------------------------------------------------------------
// Sites

export const Site = z
  .object({
    name: z.string(),
    url: z.url(),
    visibility: Visibility,
    currentDeploy: z.string().nullable(),
    domains: z.array(z.string()),
    /** People who can see it, including the owner. */
    shareCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Site" });
export type Site = z.infer<typeof Site>;
export const SiteList = list(Site);

export const EditSiteRequest = z.object({ visibility: Visibility });

// ---------------------------------------------------------------------------
// Deploys

export const ManifestEntry = z.object({
  hash: Sha256,
  size: z.number().int().nonnegative(),
  type: z.string().max(255),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;
/** Keys are absolute paths inside the site, e.g. `/index.html`. */
export const Manifest = z.record(z.string().startsWith("/").max(1024), ManifestEntry);
export type Manifest = z.infer<typeof Manifest>;

/** Where a site was last put from. Drives the `site_exists` check. */
export const Source = z.object({ path: z.string().min(1), machine: z.string().min(1) });
export type Source = z.infer<typeof Source>;

export const DeployRequest = z.object({
  files: Manifest,
  spa: z.boolean(),
  /** Applies to new sites, or with `replace`. */
  visibility: Visibility.optional(),
  /** Allow taking over a site last put from a different source. */
  replace: z.boolean().optional(),
  source: Source,
});
export type DeployRequest = z.infer<typeof DeployRequest>;

export const Deploy = z
  .object({
    id: z.string(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    spa: z.boolean(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .meta({ id: "Deploy" });
export type Deploy = z.infer<typeof Deploy>;

/** 201 for a new deploy, 200 when the manifest equals the current deploy. */
export const DeployResponse = z.object({ site: Site, deploy: Deploy });
export type DeployResponse = z.infer<typeof DeployResponse>;

export const DeployListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Return deploys older than this deploy id. */
  before: z.string().optional(),
});
export const DeployList = z.object({ data: z.array(Deploy), hasMore: z.boolean() });

export const RollbackRequest = z.object({ to: z.string().min(1) });

// ---------------------------------------------------------------------------
// Shares (private sites)

export const Share = z
  .object({
    /** An email or `@domain`. */
    entry: z.string(),
    /** The owner is always listed and can't be removed. */
    owner: z.boolean(),
  })
  .meta({ id: "Share" });
export type Share = z.infer<typeof Share>;
export const ShareList = list(Share);
export const AddSharesRequest = z.object({ entries: z.array(ShareEntry).min(1).max(100) });

// ---------------------------------------------------------------------------
// Custom domains

export const Domain = z
  .object({ host: z.string(), site: z.string(), createdAt: z.string() })
  .meta({ id: "Domain" });
export type Domain = z.infer<typeof Domain>;
export const DomainList = list(Domain);
export const DomainListQuery = z.object({ site: SiteName.optional() });
export const AddDomainRequest = z.object({ host: Hostname, site: SiteName });

// ---------------------------------------------------------------------------
// API keys

export const Key = z
  .object({
    id: KeyId,
    name: z.string(),
    email: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .meta({ id: "Key" });
export type Key = z.infer<typeof Key>;
export const KeyList = list(Key);
/** No control or format characters, so a name can't fake lines in `tray approve`. */
export const KeyName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, "no control characters");
export const CreateKeyRequest = z.object({ name: KeyName });
/** `key` is only ever returned here. */
export const CreatedKey = z.object({
  id: KeyId,
  name: z.string(),
  key: z.string().startsWith(API_KEY_PREFIX),
});
export type CreatedKey = z.infer<typeof CreatedKey>;

// ---------------------------------------------------------------------------
// Auth (device flow, RFC 8628 semantics)

export const DeviceRequest = z.object({ name: KeyName });
export const DeviceCode = z
  .object({
    deviceCode: z.string(),
    userCode: z.string(),
    verificationUri: z.url(),
    verificationUriComplete: z.url(),
    /** Seconds. */
    expiresIn: z.number().int().positive(),
    /** Seconds between polls. */
    interval: z.number().int().positive(),
  })
  .meta({ id: "DeviceCode" });
export type DeviceCode = z.infer<typeof DeviceCode>;

export const TokenRequest = z.object({ deviceCode: z.string().min(1) });
/** While pending the Worker answers 400 `authorization_pending` (or `slow_down`, `expired_token`, `access_denied`). */
export const Token = z.object({
  key: z.string().startsWith(API_KEY_PREFIX),
  email: z.string(),
  name: z.string(),
});
export type Token = z.infer<typeof Token>;

export const PendingDevice = z.object({ name: z.string(), ip: z.string(), expiresAt: z.string() });
export type PendingDevice = z.infer<typeof PendingDevice>;

/** `approve` defaults to true; `false` denies the request. */
export const ApproveRequest = z.object({ userCode: UserCode, approve: z.boolean().optional() });
