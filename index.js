import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { Configuration, OpenAIApi } from 'openai';
import bolt from '@slack/bolt';

import GeneralChatMessageProcessor from './processors/GeneralChatMessageProcessor.js';
import ImageProcessor from './processors/ImageProcessor.js';
import MentionedChatMessageProcessor from './processors/MentionedChatMessageProcessor.js';
import process_message from './utils/process_message.js';

// LowDB database
// Usage:
//   db.data.xxx = xxx;
//   await db.write();
var botId = "";
const db = new Low(new JSONFile(join(dirname(fileURLToPath(import.meta.url)), "database.json")));
await db.read();

// OpenAI initialization
const openai = new OpenAIApi(new Configuration({
    apiKey: db.data.openai.secret_key,
}));

// Processors
const processors = {
    "@": new MentionedChatMessageProcessor(openai, botId),
};
for (const channel of db.data.slack.general_chat_message.channels) {
    processors[channel] = new GeneralChatMessageProcessor(
        openai,
        db.data.slack.general_chat_message.history_size,
        db.data.slack.general_chat_message.default_system_prompt);
}
for (const channel of db.data.slack.image.channels) {
    processors[channel] = new ImageProcessor(openai, db.data.slack.image.image_size);
}

// Slack app
const slack_app = new bolt.App({
    token: db.data.slack.bot_token,
    signingSecret: db.data.slack.signing_secret,
    appToken: db.data.slack.app_token,
    socketMode: true,
});

// Slack app event handlers

slack_app.event("app_mention", async (obj) => {
    // Never process mention messages when channel is in the processors list.
    if (obj.event.channel in processors) {
        return;
    }

    const processor = processors["@"];
    await process_message(processor, obj, obj.event);
});

slack_app.message(async (obj) => {
    // Never process messages in DMs. Do not process messages which channel is not in processors list.
    if (!obj.message.channel) {
        return;
    }

    if (!(obj.message.channel in processors)) {
        console.log(obj.say({
            "text": `请将channel ID告诉管理员。\nChannel Id: ${obj.message.channel} `,
            "blocks": [
                {
                    "type": "section",
                    "text": {
                        "type": "plain_text",
                        "text": "请将channel ID告诉管理员。",
                    }
                },
                {
                    "type": "context",
                    "elements": [
                        {
                            "type": "mrkdwn",
                            "text": `Channel Id: ${obj.message.channel}`,
                        }
                    ]
                }
            ]
        }))
        //To return channel id
        console.log("\nchannel is %s\n", obj.message.channel)
        return;
    }
    // Do not response non-user messages. Do not response when messages are in threads.
    if (obj.message.subtype || obj.message.thread_ts) {
        return;
    }

    const processor = processors[obj.message.channel];
    await process_message(processor, obj, obj.event);
});

slack_app.command("/reset", async (obj) => {
    const command = obj.command;
    const ack = obj.ack;
    await ack();
    if (!(command.channel_id in processors)) {
        return;
    }
    const processor = processors[command.channel_id];
    await processor.reset(obj);
});

slack_app.command("/system", async (obj) => {
    const command = obj.command;
    const text = command.text;
    const ack = obj.ack;
    await ack();
    if (!(command.channel_id in processors)) {
        return;
    }
    const processor = processors[command.channel_id];
    if (text.trim() === "") {
        await processor.system(obj, true);
    } else {
        await processor.system(obj, false);
    }
});

// Main
(async () => {
    await slack_app.start();
    var response = await slack_app.client.auth.test();
    if ((response != null) && response.ok) {
        botId = response.bot_id;
        processors['@'].update_bot_id(botId)
    }
    console.log('⚡️ Bolt(%s) app started', botId);
})();
