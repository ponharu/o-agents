const path = require("node:path");

const micromatch = require("micromatch");

module.exports = {
  "{,scripts/**/,src/**/,test/**/}*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}": [
    "bun oxlint --fix",
    "bun oxfmt --no-error-on-unmatched-pattern",
  ],
  "./**/*.{cjs,css,cts,htm,html,js,json,json5,jsonc,jsx,md,mjs,mts,scss,ts,tsx,vue,yaml,yml}": (
    files,
  ) => {
    let filteredFiles = files.filter(
      (file) =>
        !file.includes("/test-fixtures/") &&
        !file.includes("/test/fixtures/") &&
        !file.includes("/packages/"),
    );

    filteredFiles = filteredFiles.map((file) => path.relative("", file));
    filteredFiles = micromatch.not(
      filteredFiles,
      "{,scripts/**/,src/**/,test/**/}*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
    );
    filteredFiles = filteredFiles.map((file) => path.resolve(file));
    if (filteredFiles.length === 0) return [];
    return [`bun oxfmt --no-error-on-unmatched-pattern ${filteredFiles.join(" ")}`];
  },
};
