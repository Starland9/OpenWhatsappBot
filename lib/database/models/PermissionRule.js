const { DataTypes } = require("sequelize");
const { normalizeJid } = require("../../utils/permissions");

// Literals repeated on purpose: lib/database/index.js requires every model
// synchronously and the engine (lib/utils/commandPermissions.js) requires
// ../database, so a model importing MODES / MAX_PEOPLE from the engine would
// see a half-loaded module (contracts/runtime.md section 0). A test pins that
// these equal the engine constants.
const MODES = ["extra", "only"];
const MAX_PEOPLE = 100;
const PN_SUFFIX = "@s.whatsapp.net";
const LID_SUFFIX = "@lid";

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One stored form: null, or a string with the right suffix, already normalized. */
const checkForm = (form, suffix, label) => {
  if (form === null) return;
  if (typeof form !== "string" || !form.endsWith(suffix)) {
    throw new Error(`people: ${label} must be null or end with ${suffix}`);
  }
  // No device suffix (:7), c.us mapped, lower-case server, non-empty user part
  if (normalizeJid(form) !== form) {
    throw new Error(`people: ${label} is not a normalized JID`);
  }
};

/**
 * PermissionRule Model
 * Who may use one command in one scope, beyond or instead of its normal level
 * (specs/003-command-permissions, data-model 1). One row per (command, scope);
 * no row means the command keeps its normal level. Read through the cached
 * state `settingsCache` key "command_perms" (lib/utils/commandPermissions.js);
 * written by the admin panel service only, which invalidates that key.
 *
 * On SQLite a raw `findAll` returns `people` as a string: read through model
 * instances (or `row.get({ plain: true })`).
 */
module.exports = (sequelize) => {
  const PermissionRule = sequelize.define(
    "PermissionRule",
    {
      command: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        comment: "Registry entry name (first alias, lower case)",
      },
      scope: {
        type: DataTypes.STRING(255),
        primaryKey: true,
        allowNull: false,
        defaultValue: "*",
        comment:
          "* = everywhere (every group and private chats), otherwise a group JID. Not validated by the model",
      },
      mode: {
        type: DataTypes.STRING(5),
        allowNull: false,
        validate: { isIn: [MODES] },
        comment: "extra = normal level + these people, only = these people only",
      },
      people: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          // [{ pn, lid }], at most MAX_PEOPLE; duplicates are a service invariant
          personList(value) {
            if (!Array.isArray(value)) {
              throw new Error("people must be an array");
            }
            if (value.length > MAX_PEOPLE) {
              throw new Error(`people: at most ${MAX_PEOPLE} items`);
            }
            for (const item of value) {
              if (!isPlainObject(item)) {
                throw new Error("people: each item must be an object");
              }
              const keys = Object.keys(item).sort();
              if (keys.length !== 2 || keys[0] !== "lid" || keys[1] !== "pn") {
                throw new Error("people: each item has exactly the keys pn and lid");
              }
              checkForm(item.pn, PN_SUFFIX, "pn");
              checkForm(item.lid, LID_SUFFIX, "lid");
              if (item.pn === null && item.lid === null) {
                throw new Error("people: pn and lid cannot both be null");
              }
            }
          },
        },
        comment: "List of { pn, lid }, at most 100",
      },
    },
    {
      tableName: "permission_rules",
      timestamps: true,
    }
  );

  return PermissionRule;
};
