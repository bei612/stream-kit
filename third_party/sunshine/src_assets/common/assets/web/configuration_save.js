/** Persist desired settings; an HTTP success alone is not a save acknowledgement. */
export async function persistConfiguration(config, fetchRequest) {
  const response = await fetchRequest('./api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const result = await response.json();
  if (result?.committed === true && !response.ok) {
    throw new Error('The file may already contain the changes, but persistence was not confirmed. Reload before retrying.');
  }
  if (!response.ok || result?.status !== true || result?.apply_policy !== 'encoder_restart') {
    throw new Error(typeof result?.error === 'string' ? result.error : 'Encoder configuration save was not confirmed.');
  }
  return result;
}
