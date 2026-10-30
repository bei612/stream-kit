/** Persist desired settings; an HTTP success alone is not a save acknowledgement. */
export async function persistConfiguration(config, fetchRequest, revision) {
  if (!revision) throw new Error('Read configuration before saving.');
  const response = await fetchRequest('./api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': revision },
    body: JSON.stringify(config),
  });
  const result = await response.json();
  if (result?.committed === true && !response.ok) {
    throw new Error('The file may already contain the changes, but persistence was not confirmed. Reload before retrying.');
  }
  if (!response.ok || result?.status !== true || result?.apply_policy !== 'encoder_restart') {
    throw new Error(typeof result?.error === 'string' ? result.error : 'Encoder configuration save was not confirmed.');
  }
  const nextRevision = response.headers.get('ETag');
  if (!nextRevision) throw new Error('Saved configuration revision was not confirmed; reload before retrying.');
  return { ...result, revision: nextRevision };
}
