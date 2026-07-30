// v2 (BREAKING): greet takes an options object, not a bare name.
exports.greet = (opts) => {
  if (typeof opts !== "object" || opts === null) {
    throw new TypeError("greeter@2: greet() takes { name }, not a string");
  }
  return `hello ${opts.name}`;
};
