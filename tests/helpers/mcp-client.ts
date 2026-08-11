import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const TEST_BEARER_TOKEN = "skillwire_test_0123456789abcdef";

export interface TestMcpClient {
  readonly client: Client;
  close(): Promise<void>;
}

export async function createTestMcpClient(
  endpoint: URL,
  fetchImplementation?: typeof fetch,
  bearerToken = TEST_BEARER_TOKEN,
): Promise<TestMcpClient> {
  const client = new Client({
    name: "skillwire-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: {
      token: () => Promise.resolve(bearerToken),
    },
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
  });

  await client.connect(transport);

  return {
    client,
    close: () => client.close(),
  };
}
