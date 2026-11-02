"use strict";

/**
 * Version of the public messaging API (feature 004, contracts/runtime.md section 15.12, public-api.md section 10).
 *
 *   API_VERSION     semver of the contract, `info.version` of the OpenAPI document; starts at 1.0.0 and its major
 *                   equals the path version (`/api/v1`)
 *   PATH_VERSION    "v1"
 *   BASE_PATH       "/api/v1"
 *   VERSIONING      the rules (the text of public-api.md section 10, machine-readable for the docs page)
 *
 * Compatible within v1 (no new path version): a new endpoint, a new format, a new optional request field, a new
 * response field, a new error code, a new failure code, a new right (denied to every existing key), a new value in a
 * response enum. Breaking, only through `/api/v2` served beside `v1`: removing or renaming a field, tightening the
 * validation of an existing field, changing a type, a default or a meaning, changing the code or the status of an
 * existing refusal, removing an endpoint or a format. A deprecated endpoint is flagged `deprecated: true` in the
 * document and answers with `Deprecation` and `Sunset` headers (and a `Link` to its replacement) for the announced
 * period. Clients must ignore unknown response fields and treat unknown enum values as generic.
 */

const API_VERSION = "1.0.0";
const PATH_VERSION = `v${API_VERSION.split(".")[0]}`;
const BASE_PATH = `/api/${PATH_VERSION}`;

const VERSIONING = Object.freeze({
  compatible: Object.freeze([
    "new endpoint",
    "new format",
    "new optional request field",
    "new response field",
    "new error code",
    "new failure code",
    "new right, denied to every existing key",
    "new value in a response enum",
  ]),
  breaking: Object.freeze([
    "removing or renaming a field",
    "tightening the validation of an existing field",
    "changing a type, a default or a meaning",
    "changing the code or the status of an existing refusal",
    "removing an endpoint or a format",
  ]),
});

/** Major number of a semver string */
const majorOf = (version) => Number(String(version).split(".")[0]);

module.exports = { API_VERSION, PATH_VERSION, BASE_PATH, VERSIONING, majorOf };
