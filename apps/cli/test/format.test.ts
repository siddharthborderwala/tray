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

  test("formatTable aligns columns and trims trailing space", () => {
    const t = formatTable(
      ["SITE", "URL"],
      [
        ["report", "https://report.thts.app"],
        ["docs", "https://docs.thts.app"],
      ],
    );
    expect(t).toBe(
      ["SITE     URL", "report   https://report.thts.app", "docs     https://docs.thts.app"].join(
        "\n",
      ),
    );
  });

  test("toJson: indented for a terminal, one line otherwise", () => {
    expect(toJson({ a: 1, b: [2] }, false)).toBe('{"a":1,"b":[2]}');
    expect(toJson({ a: 1 }, true)).toBe('{\n  "a": 1\n}');
    const err = new TrayError("x", "y");
    expect(formatError(err, true, true)).toBe('{\n  "error": "x",\n  "code": "y"\n}');
    expect(formatError(err, true)).toBe('{"error":"x","code":"y"}');
  });

  test("formatError: text and JSON shapes", () => {
    const err = new TrayError("report already exists", "SITE_EXISTS", 1, "use --replace");
    expect(formatError(err, false)).toBe("error: report already exists\nuse --replace");
    expect(JSON.parse(formatError(err, true))).toEqual({
      error: "report already exists",
      code: "SITE_EXISTS",
      hint: "use --replace",
    });
    expect(JSON.parse(formatError(new TrayError("x", "Y"), true))).toEqual({
      error: "x",
      code: "Y",
    });
  });

  test("tildify", () => {
    expect(tildify("/Users/sid/work/x", "/Users/sid")).toBe("~/work/x");
    expect(tildify("/Users/sidney", "/Users/sid")).toBe("/Users/sidney");
  });
});
