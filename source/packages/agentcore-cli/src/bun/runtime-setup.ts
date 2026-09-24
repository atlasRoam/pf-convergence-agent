import { bedrockProviderModule } from "@pfsaa/ai/bedrock-provider";
import { registerBunOAuthFlows } from "@pfsaa/ai/bun-oauth";
import { setBedrockProviderModule } from "@pfsaa/ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
