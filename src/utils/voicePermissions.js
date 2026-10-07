export function canUseVoiceControl(member, settings, serverQueue = null) {
  return Boolean(member && !member.user?.bot);
}
