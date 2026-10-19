// "DM access" row shared by the Home tab and the settings modal: connect or disconnect the
// opt-in user token that lets extraction read DMs the bot isn't in.

export const OAUTH_CONNECT_ACTION_ID = "oauth:connect"; // URL button; clicks need no handler
export const OAUTH_DISCONNECT_ACTION_ID = "oauth:disconnect";

export interface DmAccess {
  connected: boolean;
  /** Authorize link; null when the feature isn't configured. */
  connectUrl: string | null;
}

const button = (text: string, extra: Record<string, unknown>) => ({ type: "button", text: { type: "plain_text", text, emoji: true }, ...extra });

/** Empty when the feature is off and the user isn't connected. */
export function dmAccessBlocks(dm: DmAccess | undefined): Record<string, unknown>[] {
  if (!dm) return [];
  if (dm.connected) {
    return [
      { type: "section", block_id: "dm_access", text: { type: "mrkdwn", text: "*DM access:* connected. Plates can read your DMs when you capture a message from one." } },
      { type: "actions", block_id: "dm_access_actions", elements: [button("Disconnect DMs", { action_id: OAUTH_DISCONNECT_ACTION_ID, value: "disconnect", style: "danger" })] },
    ];
  }
  if (!dm.connectUrl) return [];
  return [
    { type: "section", block_id: "dm_access", text: { type: "mrkdwn", text: "*DM access:* not connected. Connect to let Plates read DM context when you capture a message." } },
    { type: "actions", block_id: "dm_access_actions", elements: [button("Connect DMs", { action_id: OAUTH_CONNECT_ACTION_ID, url: dm.connectUrl })] },
  ];
}
