import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.mjs";

test("POST /api/token/reset issues a new token; the old one stops working, the new one works", async () => {
  let issued = "";
  const srv = await startServer({ extra: { resetToken: () => { issued = "fresh-" + Date.now(); return issued; } } });
  try {
    const r = await srv.api("POST", "/api/token/reset");
    assert.equal(r.status, 200);
    assert.equal(r.data.token, issued);
    const old = await fetch(srv.base + "/api/bootstrap", { headers: { "x-polyphony-token": srv.token } });
    assert.equal(old.status, 401, "old token rejected");
    const fresh = await fetch(srv.base + "/api/bootstrap", { headers: { "x-polyphony-token": issued } });
    assert.equal(fresh.status, 200, "new token accepted");
  } finally {
    await srv.close();
  }
});
