import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput, ToggleField } from "../../components/agent-config-primitives";
export function AntigravityLocalConfigFields({ section, isCreate, values, set, config, eff, mark, hideInstructionsFile }: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, <>
    <Field label="Execution engine" hint="Native headless CLI. Authenticate with agy as the Paperclip OS user before running an agent.">
      <span>Antigravity CLI</span>
    </Field>
    {!hideInstructionsFile && <Field label="Agent instructions file" hint="Absolute path to Markdown instructions prepended to the task prompt.">
      <DraftInput value={isCreate ? values!.instructionsFilePath : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))}
        onCommit={value => isCreate ? set!({ instructionsFilePath: value }) : mark("adapterConfig", "instructionsFilePath", value || undefined)} immediate />
    </Field>}
    <ToggleField label="Auto-approve all tools" hint="Grants every tool request, including shell commands. Prefer scoped permissions.allow rules in Antigravity settings."
      checked={isCreate ? Boolean(values!.antigravitySkipPermissions) : eff("adapterConfig", "dangerouslySkipPermissions", Boolean(config.dangerouslySkipPermissions))}
      onChange={value => isCreate ? set!({ antigravitySkipPermissions: value }) : mark("adapterConfig", "dangerouslySkipPermissions", value)} />
  </>);
}
