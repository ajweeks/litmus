import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POST } from "../../app/api/report/route";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/report", () => {
  it("validates before touching the mailer", async () => {
    assert.equal((await post("{broken")).status, 400);
    assert.equal((await post({ message: "" })).status, 400);
    assert.equal((await post({ message: "x".repeat(2001) })).status, 400);
    assert.equal((await post({ message: "hi", email: "not an email" })).status, 400);
    assert.equal((await post({ message: "hi", email: "a@b.c<script>" })).status, 400);
  });
  it("says reports aren't set up without SMTP, and only rate-limits once a report would be sent", async () => {
    delete process.env.SMTP_URL;
    delete process.env.REPORT_TO;
    const first = await post({ message: "it broke" }, { "x-forwarded-for": "203.0.113.5" });
    assert.equal(first.status, 503);
    // The 503 happens before the sender is remembered, so a retry isn't told to wait.
    const second = await post({ message: "it broke again" }, { "x-forwarded-for": "203.0.113.5" });
    assert.equal(second.status, 503);
  });
});
