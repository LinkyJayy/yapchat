// Permission metadata shared by role and channel permission editors.
import { P } from '../store.js';

export const PERM_GROUPS = [
  ['General Server Permissions', [
    ['VIEW_CHANNELS', 'View Channels', 'Allows members to view channels by default (excluding private channels).'],
    ['MANAGE_CHANNELS', 'Manage Channels', 'Allows members to create, edit, or delete channels.'],
    ['MANAGE_ROLES', 'Manage Roles', 'Allows members to create new roles and edit or delete roles lower than their highest role.'],
    ['MANAGE_EMOJIS', 'Manage Emojis', 'Allows members to add or remove custom emojis in this server.'],
    ['VIEW_AUDIT_LOG', 'View Audit Log', 'Allows members to view a record of who made which changes in this server.'],
    ['MANAGE_SERVER', 'Manage Server', "Allows members to change this server's name, icon, banner and PIN."],
  ]],
  ['Membership Permissions', [
    ['CHANGE_NICKNAME', 'Change Nickname', 'Allows members to change their own nickname in this server.'],
    ['MANAGE_NICKNAMES', 'Manage Nicknames', "Allows members to change the nicknames of other members."],
    ['KICK_MEMBERS', 'Kick Members', 'Allows members to remove other members from this server.'],
    ['BAN_MEMBERS', 'Ban Members', 'Allows members to permanently ban other members from this server.'],
    ['MODERATE_MEMBERS', 'Timeout Members', 'Allows members to temporarily stop users from chatting, reacting, or speaking.'],
  ]],
  ['Text Channel Permissions', [
    ['SEND_MESSAGES', 'Send Messages', 'Allows members to send messages in text channels.'],
    ['READ_HISTORY', 'Read Message History', 'Allows members to read previous messages.'],
    ['ADD_REACTIONS', 'Add Reactions', 'Allows members to add new emoji reactions to messages.'],
    ['ATTACH_FILES', 'Attach Files', 'Allows members to upload files or media.'],
    ['EMBED_LINKS', 'Embed Links', 'Allows links that members share to show embedded content.'],
    ['USE_EXTERNAL_EMOJIS', 'Use External Emojis', 'Allows members to use custom emojis from other servers.'],
    ['CREATE_POLLS', 'Create Polls', 'Allows members to create polls.'],
    ['MENTION_EVERYONE', 'Mention @everyone, @here, and All Roles', 'Allows members to ping everyone and any role, even if not mentionable.'],
    ['MANAGE_MESSAGES', 'Manage Messages', "Allows members to delete or pin other members' messages and end polls."],
  ]],
  ['Voice Channel Permissions', [
    ['CONNECT', 'Connect', 'Allows members to join voice channels.'],
    ['SPEAK', 'Speak', 'Allows members to talk in voice channels.'],
    ['VIDEO', 'Video & Screen Share', 'Allows members to share their camera or screen.'],
    ['MUTE_MEMBERS', 'Mute Members', 'Allows members to mute other members in voice channels for everyone.'],
    ['MOVE_MEMBERS', 'Disconnect Members', 'Allows members to disconnect other members from voice channels.'],
  ]],
  ['Advanced Permissions', [
    ['ADMINISTRATOR', 'Administrator', 'Members with this permission have every permission and bypass channel-specific permissions. Be careful granting this.'],
  ]],
];

export const CHANNEL_PERM_KEYS = ['VIEW_CHANNELS', 'MANAGE_CHANNELS', 'SEND_MESSAGES', 'READ_HISTORY', 'ADD_REACTIONS', 'ATTACH_FILES', 'EMBED_LINKS',
  'USE_EXTERNAL_EMOJIS', 'CREATE_POLLS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'CONNECT', 'SPEAK', 'VIDEO', 'MUTE_MEMBERS', 'MOVE_MEMBERS'];

export const permLabel = (key) => {
  for (const [, list] of PERM_GROUPS) for (const [k, l, d] of list) if (k === key) return { label: l, desc: d, bit: P[k] };
  return { label: key, desc: '', bit: P[key] };
};
