/** How connect and summary failures should read. A refresh cap still connected the bank. */

export const CONNECTED_LATER = "Connected — refresh available in a few minutes";

export function connectNotice(
  result: { error: string; status: number } | { syncMore: boolean },
): { alert: boolean; text: string } {
  if ("error" in result) {
    // The item is already stored when the hourly sync cap rejects the first import.
    if (result.status === 429 && /refresh limit/i.test(result.error)) {
      return { alert: false, text: CONNECTED_LATER };
    }
    return { alert: true, text: result.error };
  }
  return {
    alert: false,
    text: result.syncMore ? "Connected. Choose Continue to finish importing." : "Demo bank connected.",
  };
}

/** The third regeneration is a limit message. Keep the summary; don't replace it with an error state. */
export function explainIsLimit(status: number, hasSummary: boolean): boolean {
  return status === 429 && hasSummary;
}
