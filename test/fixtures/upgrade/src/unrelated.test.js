const { test } = require("node:test");
const assert = require("node:assert");
const { add } = require("./unrelated.js");

test("add adds", () => {
  assert.equal(add(1, 2), 3);
});
