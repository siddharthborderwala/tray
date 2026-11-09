import { apiError } from "../src/api.ts";
import { describe, expect, test } from "bun:test";
import { TrayError } from "../src/errors.ts";
import {
  formatBytes,
  formatError,
  formatTable,
  relativeTime,
  tildify,
  toJson,
} from "../src/format.ts";

describe("format", () => {
  test("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });

  test("relativeTime", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-01-10T11:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-01-10T11:58:00Z", now)).toBe("2m ago");
    expect(relativeTime("2026-01-07T12:00:00Z", now)).toBe("3d ago");
  });

  test("formatTable: aligned on a terminal, tab-separated when piped", () => {
    const rows = [
      ["report", "https://report.acme.dev"],
      ["docs", "https://docs.acme.dev"],
    ];
    expect(formatTable(["SITE", "URL"], rows)).toBe(
      "SITE     URL\nreport   https://report.acme.dev\ndocs     https://docs.acme.dev",
    );
    expect(formatTable(["SITE", "URL"], rows, false)).toBe(
      "SITE\tURL\nreport\thttps://report.acme.dev\ndocs\thttps://docs.acme.dev",
    );
    expect(toJson({ a: 1 }, true)).toBe('{\n  "a": 1\n}');
    expect(toJson({ a: 1, b: [2] }, false)).toBe('{"a":1,"b":[2]}');
  });

  test("formatError: headline, details, label and commands; JSON is one line with the same parts", () => {
    const err = new TrayError(
      "Not logged in to acme.dev",
      "not_logged_in",
      4,
      "Log in:",
      undefined,
      {
        details: ["the key was revoked"],
        next: ["tray login acme.dev"],
      },
    );
    expect(formatError(err, { json: false })).toBe(
      "Error: Not logged in to acme.dev.\n  the key was revoked\n\nLog in:\n    tray login acme.dev",
    );
    expect(formatError(err, { json: false, color: true })).toStartWith(
      "\x1b[31m✗\x1b[0m Not logged in",
    );
    expect(JSON.parse(formatError(err, { json: true }))).toEqual({
      error: "Not logged in to acme.dev",
      code: "not_logged_in",
      hint: "Log in:",
      details: ["the key was revoked"],
      next: ["tray login acme.dev"],
    });
    // Server text is printed inert: escapes and extra lines can't spoof the terminal.
    const spoof = new TrayError(
      "x exists (last put from \x1b]52;c;ZXZpbA==\x07\nError: fake)",
      "site_exists",
    );
    const shown = formatError(spoof, { json: false });
    expect(
      shown.includes("\u001b") || shown.includes("\u0007") || shown.includes("\nError: fake"),
    ).toBe(false);
    // Canceling isn't an error.
    expect(
      formatError(new TrayError("Canceled. Nothing was changed.", "canceled"), { json: false }),
    ).toBe("Canceled. Nothing was changed.");
    // API errors keep their extra fields.
    const api = apiError(
      { status: 409, headers: new Headers() },
      {
        error: "2 blob(s) not uploaded yet",
        code: "missing_blobs",
        param: "files",
        missing: ["a"],
      },
    );
    expect(JSON.parse(formatError(api, { json: true }))).toMatchObject({
      param: "files",
      missing: ["a"],
    });
  });

  test("tildify", () => {
    expect(tildify("/Users/sid/work/x", "/Users/sid")).toBe("~/work/x");
    expect(tildify("/Users/sidney", "/Users/sid")).toBe("/Users/sidney");
  });
});
