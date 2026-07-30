// Import site #2, reached by NO test — this is the uncovered part of the upgrade surface.
const { greet } = require("greeter");

exports.audit = (name) => greet(name).length;
