// Standalone mock servers for poking at the worker by hand: `npm run local:mock`.
import { MOCK_PORT, MockServers } from "./mock-servers.ts";

const mocks = new MockServers(Number(process.env.MOCK_PORT ?? MOCK_PORT));
await mocks.start();
console.log(`mock servers on ${mocks.origin}`);
console.log(`  SLACK_API_URL=${mocks.slackApiUrl}`);
console.log(`  LLM_BASE_URL=${mocks.anthropicBaseUrl}`);
console.log("  control: POST /control/script, GET /control/calls, POST /control/reset");
