/**
 * Turns raw Foundry connection/login failures into a plain-language cause and
 * fix. The raw message is always kept; the hint is appended.
 */

const HINTS: Array<[RegExp, string]> = [
  [
    /not running|NOT_RUNNING/i,
    'The Foundry instance is stopped (hosts like Molten shut idle servers down). Start it from your hosting dashboard; the connection will be retried automatically and succeed once it is up.',
  ],
  [
    /JOIN\.ErrorUserDoesNotExist/i,
    'Foundry could not match the user. Check FOUNDRY_USERNAME (it is the display name, case-sensitive). On Foundry v14 this also appears if the join request used the wrong id key.',
  ],
  [
    /JOIN\.ErrorInvalidPassword|incorrect password|invalid password/i,
    'The password was rejected. Check FOUNDRY_PASSWORD for the Foundry user (not the hosting account).',
  ],
  [
    /could not be processed/i,
    'Foundry v14 rejected the join request, usually because the Origin header is missing. The local auth patch adds it; if you updated the server, re-apply it.',
  ],
  [
    /No session cookie returned|Could not extract session cookie/i,
    'Foundry did not start a session. The world is probably stopped, still starting, or the host is restarting. Launch the world from the Foundry setup screen and retry.',
  ],
  [
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    'Cannot reach the Foundry host. Check FOUNDRY_URL and that the server is running and your network is up.',
  ],
  [
    /ETIMEDOUT|ECONNRESET|socket hang up|timeout/i,
    'The connection timed out or was reset. The host may be asleep or busy; retrying usually fixes it.',
  ],
  [
    /status code 50[234]|HTTP 50[234]/i,
    'The hosting proxy answered with a gateway error. The Foundry instance is likely restarting or asleep.',
  ],
  [
    /status code 404/i,
    'Foundry answered 404. The URL may be wrong, or no world is currently launched.',
  ],
];

export function explainConnectionError(message: string): string {
  for (const [pattern, hint] of HINTS) {
    if (pattern.test(message)) {
      return `${message} — ${hint}`;
    }
  }
  return message;
}
