// Import site #1 — calls greet() the v1 way (a bare name). The v2 bump breaks exactly here.
const { greet } = require("greeter");

exports.welcome = (name) => greet(name).toUpperCase();
