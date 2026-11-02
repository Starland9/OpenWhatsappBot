const { DataTypes } = require("sequelize");

// Literals repeated on purpose (see ApiKey.js).
const KINDS = ["choice", "vote"];
const VIAS = ["tap", "number"];

/**
 * ApiMessageResponse Model
 * What a recipient chose on an interactive API message (specs/004-messaging-api, data-model 3). Written by the
 * reply-capture module only (lib/messaging/replies.js); removed with the message by the retention purge. Excluded
 * from backups.
 *
 * The unique indexes carry the recording rules, and NULLs are distinct in them:
 *   (messageId, voterKey)  last vote replaces: one `vote` row per voter; `choice` rows have voterKey NULL
 *   (messageId, sourceId)  a redelivered event cannot double-count
 * `choiceIds` is JSON: read through model instances, never `raw: true`.
 */
module.exports = (sequelize) => {
  const ApiMessageResponse = sequelize.define(
    "ApiMessageResponse",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      messageId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: "Logical link to api_messages.id",
      },
      kind: {
        type: DataTypes.STRING(6),
        allowNull: false,
        validate: { isIn: [KINDS] },
        comment: "choice (button or list) | vote (poll)",
      },
      author: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: "Private chat: the message's recipient; group: the participant (PN when known, else LID)",
      },
      voterKey: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: "vote: equals author; choice: NULL",
      },
      choiceIds: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          idList(value) {
            if (!Array.isArray(value)) throw new Error("choiceIds must be an array");
            if (!value.every((id) => typeof id === "string")) throw new Error("choiceIds: each item must be a string");
          },
        },
        comment: "Ids of the message's choices: exactly one for a choice, the current selection for a vote",
      },
      via: {
        type: DataTypes.STRING(6),
        allowNull: true,
        validate: { isIn: [VIAS] },
        comment: "tap | number for a choice; NULL for a vote",
      },
      sourceId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: "WhatsApp id of the reply or vote message, the redelivery guard",
      },
      respondedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: "The reply's own timestamp",
      },
    },
    {
      tableName: "api_message_responses",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["messageId", "voterKey"] },
        { unique: true, fields: ["messageId", "sourceId"] },
        { fields: ["messageId", "respondedAt"] },
        { fields: ["respondedAt"] },
      ],
    }
  );

  return ApiMessageResponse;
};
