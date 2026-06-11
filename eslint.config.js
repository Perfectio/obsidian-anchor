import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // stdout is reserved for the MCP stdio transport (JSON-RPC). Any stray
      // stdout write corrupts the protocol, so all logging must go to stderr
      // via util/logger.ts. Ban console.* in server source.
      "no-console": "error",
    },
  },
);
