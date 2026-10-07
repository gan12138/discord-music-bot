import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { GuildSettings } from '../src/models/database.js';
import {
  hasMusicPermission,
  inspectVoiceContext,
  safeEditReply,
} from '../src/utils/commandSafety.js';

function member({ roleId = null } = {}) {
  const roles = roleId ? [{ id: roleId }] : [];
  return {
    roles: {
      cache: {
        has: id => roles.some(role => role.id === id),
        some: predicate => roles.some(predicate),
      },
    },
  };
}

function permissions(values) {
  return { has: value => values.includes(value) };
}

test('DJ role and ManageGuild permissions are enforced consistently', () => {
  const guildId = `permissions-${Date.now()}`;
  const roleId = '123456789012345678';
  GuildSettings.update(guildId, { djRole: roleId });

  try {
    const regular = { guildId, member: member(), memberPermissions: permissions([]) };
    const dj = { guildId, member: member({ roleId }), memberPermissions: permissions([]) };
    const manager = { guildId, member: member(), memberPermissions: permissions([PermissionFlagsBits.ManageGuild]) };
    assert.equal(hasMusicPermission(regular), false);
    assert.equal(hasMusicPermission(dj), true);
    assert.equal(hasMusicPermission(manager), true);
    assert.equal(hasMusicPermission(regular, { manageGuildOnly: true }), false);
    assert.equal(hasMusicPermission(manager, { manageGuildOnly: true }), true);
  } finally {
    GuildSettings.update(guildId, { djRole: null });
  }
});

test('voice context checks ViewChannel, Connect, Speak, and same channel', () => {
  const channel = {
    id: 'voice',
    permissionsFor: () => permissions(['ViewChannel', 'Connect', 'Speak']),
  };
  const interaction = {
    member: { voice: { channel } },
    guild: { members: { me: { voice: { channel } } } },
  };
  assert.equal(inspectVoiceContext(interaction, { requireBotInVoice: true }).ok, true);

  const otherChannel = { id: 'other', permissionsFor: channel.permissionsFor };
  assert.equal(inspectVoiceContext({
    ...interaction,
    member: { voice: { channel: otherChannel } },
  }, { requireBotInVoice: true }).ok, false);
});

test('safeEditReply removes ephemeral flags from edit payloads', () => {
  let payload = null;
  safeEditReply({ editReply: value => { payload = value; } }, {
    content: 'result',
    flags: 64,
  });
  assert.deepEqual(payload, {
    content: 'result',
    allowedMentions: { parse: [] },
  });
});
