// A link that opens Cloudflare's "Create API token" page with everything
// `tray setup` needs already filled in.
//
// Format (user-owned token template URL):
//   https://dash.cloudflare.com/profile/api-tokens
//     ?permissionGroupKeys=<url-encoded JSON [{ key, type }]>&accountId=*&zoneId=all&name=<name>
// Source for the format, the `{ key, type }` shape and every key below:
// https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// ("Permission reference" tables).
//
// A user-owned token is used because its template can pre-fill the account and
// zone scope; account-owned template URLs can't. `zoneId=all` because the
// zone id isn't known before there is a token, and `tray domain add` needs
// the other zones on the account too.

/** Permission groups setup needs, as `permissionGroupKeys` entries. */
export const TOKEN_PERMISSION_KEYS = [
  { key: "workers_scripts", type: "edit" }, // Workers Scripts Edit (account)
  { key: "workers_r2", type: "edit" }, // Workers R2 Storage Edit (account)
  { key: "access", type: "edit" }, // Access: Apps and Policies Edit (account)
  { key: "access_acct", type: "edit" }, // Access: Organizations, Identity Providers, and Groups Edit (account)
  { key: "zone", type: "read" }, // Zone Read (zone)
  { key: "dns", type: "edit" }, // DNS Edit (zone)
  { key: "workers_routes", type: "edit" }, // Workers Routes Edit (zone)
] as const;

/** The prefilled "Create API token" link for a tray on `domain`. */
export function tokenTemplateUrl(domain: string): string {
  const keys = encodeURIComponent(JSON.stringify(TOKEN_PERMISSION_KEYS));
  const name = encodeURIComponent(`tray-${domain}`);
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${name}`;
}
