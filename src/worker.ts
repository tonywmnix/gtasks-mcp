import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { google } from "googleapis";
import { createMcpServer } from "./server.js";

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_ACCESS_TOKEN: string;
  GOOGLE_REFRESH_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({
      access_token: env.GOOGLE_ACCESS_TOKEN,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    });
    google.options({ auth });

    const tasks = google.tasks("v1");
    const server = createMcpServer(tasks);

    // sessionIdGenerator: undefined enables stateless mode (no persistent sessions),
    // which is appropriate for Cloudflare Workers' per-request execution model.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    return transport.handleRequest(request);
  },
};
