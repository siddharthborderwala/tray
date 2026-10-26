// Device-code login (RFC 8628 semantics, no OAuth formalities).
import { createRoute, z } from "@hono/zod-openapi";
import {
  ApproveRequest,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  DeviceCode,
  DeviceRequest,
  PendingDevice,
  Token,
  TokenRequest,
  UserCode,
} from "@tray-sh/schema";
import { decideDevice, deleteDevice, findDevice, startDevice } from "../auth.ts";
import { TrayError } from "../errors.ts";
import { bearer, body, errors, json, newRouter } from "../router.ts";
import { getJson, now, paths, type PendingDevice as PendingRecord, putJson } from "../storage.ts";

const device = createRoute({
  method: "post",
  path: "/auth/device",
  operationId: "startDeviceLogin",
  summary: "Start a device login",
  description:
    "No auth. Returns a device code for the CLI to poll with and a user code for the owner to approve at `verificationUriComplete` or with `tray approve`.",
  request: { body: body(DeviceRequest) },
  responses: { 200: json(DeviceCode, "Codes for the CLI and the approver"), ...errors() },
});

const token = createRoute({
  method: "post",
  path: "/auth/token",
  operationId: "pollDeviceToken",
  summary: "Poll for a device login's API key",
  description:
    "No auth. Returns 400 `authorization_pending` until approved, `slow_down` when polling faster than `interval`, `expired_token` when the code expired or was used, or `access_denied` when denied. On approval returns the key once.",
  request: { body: body(TokenRequest) },
  responses: { 200: json(Token, "Approved: the key, shown once"), ...errors() },
});

const getDevice = createRoute({
  method: "get",
  path: "/auth/device/{userCode}",
  operationId: "getDeviceLogin",
  summary: "Look up a pending device login",
  description:
    "Returns the device name and IP for a user code so `tray approve` can show them before approving.",
  security: bearer,
  request: { params: z.object({ userCode: UserCode }) },
  responses: { 200: json(PendingDevice, "The pending login"), ...errors() },
});

const approve = createRoute({
  method: "post",
  path: "/auth/approve",
  operationId: "approveDeviceLogin",
  summary: "Approve or deny a device login",
  description:
    "Mints an API key bound to the approver's email and the device name. `approve: false` denies. Accepts an API key or the owner's Cloudflare Access identity. Repeating the same decision is a no-op.",
  security: bearer,
  request: { body: body(ApproveRequest) },
  responses: { 204: { description: "Done" }, ...errors() },
});

const deviceError = (
  code: "authorization_pending" | "slow_down" | "expired_token" | "access_denied",
  message: string,
) => new TrayError(400, code, message);

export const auth = newRouter()
  .openapi(device, async (c) => {
    const { name } = c.req.valid("json");
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { deviceCode, userCode } = await startDevice(c.env, name, ip);
    const verificationUri = `https://tray.${c.env.DOMAIN}/approve`;
    return c.json(
      {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: `${verificationUri}?code=${userCode}`,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      },
      200,
    );
  })

  .openapi(token, async (c) => {
    const { deviceCode } = c.req.valid("json");
    const key = /^[a-f0-9]{64}$/.test(deviceCode) ? paths.pending(deviceCode) : null;
    const pending = key ? await getJson<PendingRecord>(c.env.BUCKET, key) : null;
    if (!pending) throw deviceError("expired_token", "this login has expired or was already used");

    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await deleteDevice(c.env, deviceCode, pending.userCode);
      throw deviceError("expired_token", "this login has expired; run `tray login` again");
    }
    if (pending.status === "denied") {
      await deleteDevice(c.env, deviceCode, pending.userCode);
      throw deviceError("access_denied", "the login was denied");
    }
    if (pending.status === "approved" && pending.key && pending.email) {
      await deleteDevice(c.env, deviceCode, pending.userCode); // single use
      return c.json({ key: pending.key, email: pending.email, name: pending.name }, 200);
    }

    // RFC 8628 §3.5: polling faster than `interval` → slow_down (1s grace for clock jitter).
    const last = pending.lastPollAt ? Date.parse(pending.lastPollAt) : 0;
    const tooFast = Date.now() - last < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000;
    pending.lastPollAt = now();
    await putJson(c.env.BUCKET, key!, pending);
    if (tooFast)
      throw deviceError("slow_down", `poll at most every ${DEVICE_POLL_INTERVAL_SECONDS}s`);
    throw deviceError("authorization_pending", "waiting for approval");
  })

  .openapi(getDevice, async (c) => {
    const { pending } = await findDevice(c.env, c.req.valid("param").userCode);
    if (pending.status !== "pending") {
      throw new TrayError(400, "expired_token", "this code was already used", {
        param: "userCode",
      });
    }
    return c.json({ name: pending.name, ip: pending.ip, expiresAt: pending.expiresAt }, 200);
  })

  .openapi(approve, async (c) => {
    const { userCode, approve } = c.req.valid("json");
    await decideDevice(c.env, userCode, approve !== false, c.var.identity.email);
    return c.body(null, 204);
  });
