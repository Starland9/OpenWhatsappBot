"use strict";

/**
 * Format `location` (feature 004, contracts/runtime.md section 3.6, public-api.md 3.5): a point on the map with an
 * optional name and address. No media, no size.
 */

const { LIMITS } = require("../limits");

module.exports = {
  name: "location",
  order: 90,
  interactive: false,

  fields: {
    latitude: { type: "number", required: true, min: -90, max: 90 },
    longitude: { type: "number", required: true, min: -180, max: 180 },
    name: { type: "string", minLength: 1, maxLength: LIMITS.LOCATION_TEXT, trim: true },
    address: { type: "string", minLength: 1, maxLength: LIMITS.LOCATION_TEXT, trim: true },
  },
  form: { hints: { latitude: { step: 0.000001 }, longitude: { step: 0.000001 }, name: { type: "text" }, address: { type: "text" } } },

  size() {
    return null;
  },

  build(ctx) {
    const { input } = ctx;
    return {
      content: {
        location: {
          degreesLatitude: input.latitude,
          degreesLongitude: input.longitude,
          ...(input.name ? { name: input.name } : {}),
          ...(input.address ? { address: input.address } : {}),
        },
      },
    };
  },

  doc: {
    summary: "Send a location",
    description: "Sends a map location (latitude -90..90, longitude -180..180) with an optional name and address.",
    examples: [{ format: "location", to: "237690000001", latitude: 4.0511, longitude: 9.7679, name: "Pickup point", address: "Rue de la Joie, Douala" }],
  },
};
