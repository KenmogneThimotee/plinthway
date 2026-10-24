# plinthway

Plinthway is a local-first, policy-controlled terminal runtime for AI models, native tools, and Model Context Protocol servers.

Requires Node.js 24.

```bash
npm install --global plinthway
plinthway chat
```

It provides named work profiles, a searchable Models.dev catalog, eligible ChatGPT subscription and API-key providers, explicit persistent MCP connections, built-in filesystem and shell tools, approval boundaries, and durable sessions.

Connect an eligible ChatGPT Plus or Pro account with `plinthway auth login chatgpt`, or choose **ChatGPT subscription** inside chat. Tokens are stored in the operating-system keyring, and ChatGPT plan use never silently falls back to OpenAI API billing.

For documentation, security guidance, and contribution instructions, visit [github.com/KenmogneThimotee/plinthway](https://github.com/KenmogneThimotee/plinthway).
