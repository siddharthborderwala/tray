// The API v1 shapes the CLI uses (SPEC.md §5), from the shared schema package.
// Kept as one re-export list so the CLI's dependency on the wire format is
// visible in one place.
export {
  ApiError,
  Blob,
  CHECK_BATCH_SIZE,
  CheckBlobsResponse,
  CreatedKey,
  Deploy,
  DeployList,
  DeployResponse,
  DeviceCode,
  Domain,
  DomainList,
  KeyList,
  MAX_DEPLOY_BYTES,
  PendingDevice,
  RESERVED_SITE_NAMES,
  SITE_NAME_RE,
  ShareEntry,
  ShareList,
  Site,
  SiteList,
  SiteName,
  Token,
  Visibility,
} from "@tray/schema";
export type { DeployRequest, Key, Manifest, Share } from "@tray/schema";
