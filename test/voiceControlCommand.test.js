import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { data as voiceControlData } from '../src/commands/voice-control.js';
import { data as voiceConsentData } from '../src/commands/voice-consent.js';

test('voice control exposes only off and everyone STT policies', () => {
  const command = voiceControlData.toJSON();
  assert.equal(command.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  const policy = command.options.find(option => option.name === 'stt-policy');
  assert.ok(policy);
  const mode = policy.options.find(option => option.name === 'mode');
  assert.deepEqual(mode.choices.map(choice => choice.value), ['off', 'everyone']);
  assert.equal(policy.options.some(option => option.name === 'confirm'), false);
  assert.equal(command.options.some(option => option.name === 'permission'), false);
  assert.equal(command.options.some(option => option.name === 'role'), false);
  assert.equal(command.options.some(option => option.name === 'commands'), false);
});

test('voice consent only changes the invoking member state', () => {
  const command = voiceConsentData.toJSON();
  assert.deepEqual(command.options.map(option => option.name), ['grant', 'revoke', 'status']);
  assert.equal(command.options.some(option => option.options?.some(child => child.name === 'user')), false);
});
