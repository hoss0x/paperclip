import type { UIAdapterModule } from "../types";
import { parseAntigravityStdoutLine, buildAntigravityLocalConfig } from "@paperclipai/adapter-antigravity-local/ui";
import { AntigravityLocalConfigFields } from "./config-fields";
export const antigravityLocalUIAdapter: UIAdapterModule = {
  type: "antigravity_local", label: "Antigravity CLI",
  parseStdoutLine: parseAntigravityStdoutLine,
  ConfigFields: AntigravityLocalConfigFields, buildAdapterConfig: buildAntigravityLocalConfig,
};
