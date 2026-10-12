import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";

/** Keep each launch single-use while owning replacements for transient ACP controls. */
export function createAcpxCommandLeaseOwner(
  initial: VerifiedAcpxCommandLease,
  openCommand: () => Promise<VerifiedAcpxCommandLease>,
) {
  const leases = new Set([initial]);
  let current = initial;
  let consumed = false;
  let closing = false;
  let refresh: Promise<void> | null = null;
  let cleanup: Promise<void> | null = null;
  const command: VerifiedAcpxCommandLease = {
    spawn(...args) {
      if (closing) throw new Error("Verified ACPX command owner is closing");
      consumed = true;
      return current.spawn(...args);
    },
    close() {
      closing = true;
      return cleanup ??= (async () => {
        // Concurrent abort/runtime paths share this attempt; later calls retry
        // only leases whose cleanup failed, including late refresh acquisitions.
        await refresh?.catch(() => undefined);
        const failures: unknown[] = [];
        for (const lease of leases) {
          try {
            await lease.close();
            leases.delete(lease);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, "ACPX command leases did not close");
      })().finally(() => { cleanup = null; });
    },
  };
  return {
    command,
    async refreshConsumedCommand(): Promise<void> {
      if (closing) throw new Error("Verified ACPX command owner is closing");
      if (!consumed) return;
      if (!refresh) {
        refresh = Promise.resolve()
          .then(openCommand)
          .then((replacement) => {
            leases.add(replacement);
            if (closing) throw new Error("Verified ACPX command owner closed during refresh");
            current = replacement;
            consumed = false;
          });
      }
      const pending = refresh;
      try {
        await pending;
      } finally {
        if (refresh === pending) refresh = null;
      }
    },
  };
}
