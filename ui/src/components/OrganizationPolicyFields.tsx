import { organizationActions, organizationPolicyModes, type OrganizationPolicy } from "@paperclipai/shared";
export function OrganizationPolicyFields({ value, onChange }: { value: OrganizationPolicy; onChange: (value: OrganizationPolicy) => void }) {
  const options = organizationPolicyModes.map(mode => <option key={mode} value={mode}>{mode}</option>);
  const style = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return <fieldset className="space-y-3"><legend className="font-medium">Employee action restrictions</legend>
    <p className="text-sm text-muted-foreground">These restrictions combine with each employee’s Contract and existing Paperclip authorization. Approval-required actions must be reviewed and performed by the board.</p>
    <label className="block text-sm">Default action policy<select className={style} value={value.defaultMode} onChange={e => onChange({ ...value, defaultMode: e.target.value as "allowed" | "denied" })}><option value="allowed">allowed</option><option value="denied">denied</option></select></label>
    {organizationActions.map(action => <label key={action} className="block text-sm">{action}<select className={style} value={value.permissions[action] ?? ""} onChange={e => { const permissions = { ...value.permissions }; if (e.target.value) permissions[action] = e.target.value as typeof organizationPolicyModes[number]; else delete permissions[action]; onChange({ ...value, permissions }); }}><option value="">Use default</option>{options}</select></label>)}
  </fieldset>;
}
