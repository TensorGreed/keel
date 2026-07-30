// A transitive dependent: no direct dependency on greeter, but it is in the blast radius.
const { welcome } = require("./welcome.js");

exports.banner = (name) => `*** ${welcome(name)} ***`;
