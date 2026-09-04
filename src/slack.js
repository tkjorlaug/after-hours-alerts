const { WebClient } = require('@slack/web-api');

const { SLACK_BOT_TOKEN, SLACK_EMERGENCY_CHANNEL } = process.env;
const client = new WebClient(SLACK_BOT_TOKEN);

function extFor(contentType) {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mp4') || contentType.includes('m4a') || contentType.includes('aac')) return 'm4a';
  return 'mp3';
}

// Uploads the recording to the channel with the caller number as the message.
// files.uploadV2 posts the file inline, so Slack renders a native audio player.
async function postVoicemail({ callerAni, receivedAt, buf, contentType }) {
  const when = new Date(receivedAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const from = callerAni || 'Unknown caller';

  await client.files.uploadV2({
    channel_id: SLACK_EMERGENCY_CHANNEL,
    file: buf,
    filename: `emergency-voicemail.${extFor(contentType)}`,
    title: `Emergency voicemail from ${from}`,
    initial_comment: `🚨 *Emergency voicemail*\n*From:* ${from}\n*Received:* ${when} ET`,
  });
}

module.exports = { postVoicemail };
