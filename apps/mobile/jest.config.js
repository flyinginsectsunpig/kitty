/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  roots: ["<rootDir>/test"],
  testPathIgnorePatterns: ["/node_modules/", "/test/support/", "/test/setup.ts"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
};
