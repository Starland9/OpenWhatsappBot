/**
 * Reply capture of the messaging API (feature 004: specs/004-messaging-api/contracts/runtime.md section 7.1).
 *
 * Hook-only plugin (like `groupguard.js` and `trackmessages.js`: no `command`, nothing to type): it records what a
 * person answered to an interactive API message and consumes that answer, so that no other feature reacts to it.
 *
 *  - `handleButtonReply` (pipeline step 5, priority 5, before every game's hook): a tap on a button or a row of an API
 *    message (the id is `api:reply:<waId>:<id>`), or a bare number quoting one;
 *  - `onMessage` (priority 6, right after `knownchats`): a poll vote (`pollUpdateMessage`) on one of the API's polls.
 *
 * Thin: both hooks call `lib/messaging/replies.js`, which loads nothing heavy until a vote has to be decrypted. The
 * hooks never throw (the pipeline isolates each one anyway) and cost one indexed lookup per candidate message.
 */

const replies = require("../lib/messaging/replies");

module.exports = {
  hookPriority: { handleButtonReply: 5, onMessage: 6 },

  /** Taps and quoted numbers: true when the message is a reply to an API message */
  async handleButtonReply(message) {
    return replies.handleButtonReply(message);
  },

  /** Poll votes: true when the poll is one of the API's */
  async onMessage(message) {
    return replies.handlePollVote(message);
  },
};
