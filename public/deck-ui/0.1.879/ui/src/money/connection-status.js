// Provider codes stay at the API boundary; screens show the next useful action.
export function connectionStatus(connection) {
  const institution = connection.institution ?? 'bank';
  const code = connection.last_error;
  if (code === 'ADDITIONAL_CONSENT_REQUIRED' || code === 'ITEM_LOGIN_REQUIRED' ||
      code === 'ITEM_LOCKED' || code === 'ITEM_ACCESS_NOT_GRANTED' ||
      ['login_required', 'revoked'].includes(connection.status)) {
    return `${code === 'ADDITIONAL_CONSENT_REQUIRED' ? 'Re-approve' : 'Reconnect'} ${institution}`;
  }
  if (connection.status === 'ok') return 'Connected';
  if (code === 'INSTITUTION_DOWN' || code === 'INSTITUTION_NOT_RESPONDING') return `${institution} is temporarily unavailable`;
  return 'Could not sync. Try reconnecting';
}

/** Whether the owner's next step is Plaid Link again (reconnect or re-approve). */
export const needsRelink = connection => /^(Reconnect|Re-approve) /.test(connectionStatus(connection));

/** What Plaid Link said when it closed with an error (onExit's err), or null when the person closed it. */
export const linkExitText = err => err ? `Plaid stopped: ${err.display_message || err.error_message || 'no reason given'}${err.error_code ? ` (${err.error_code})` : ''}` : null;
