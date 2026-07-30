const { test } = require("node:test");
const assert = require("node:assert");
const { banner } = require("./banner.js");

test("banner greets", () => {
  assert.equal(banner("ada"), "*** HELLO ADA ***");
});
