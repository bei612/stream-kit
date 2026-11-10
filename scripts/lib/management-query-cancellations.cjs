'use strict';

// Evidence-only classification. A client-aborted management read is expected
// only if a newer identical read actually completed with HTTP 2xx. Mutations,
// viewer traffic, missing identities, timeout/TLS/reset and failed replacements
// remain failures. Private transport keys never appear in returned evidence.
function managementQueryCancellations(failures, requests, managementOwner) {
  const expected = [];
  for (const failure of failures) {
    if (failure.owner !== managementOwner || failure.management_read !== true ||
        failure.method !== 'GET' || failure.reason !== 'net::ERR_ABORTED' ||
        !Number.isSafeInteger(failure.request_id) || failure.request_id <= 0 || failure.request_id !== failure.started_order ||
        !Number.isSafeInteger(failure.failed_order) || typeof failure.request_key !== 'string' || !failure.request_key ||
        (failure.response_status != null && !(Number.isInteger(failure.response_status) && failure.response_status >= 200 && failure.response_status < 300))) continue;
    const replacement = requests.find(request =>
      request.owner === managementOwner && request.management_read === true && request.method === 'GET' &&
      request.request_key === failure.request_key && request.request_id !== failure.request_id &&
      Number.isSafeInteger(request.request_id) && request.request_id === request.started_order && request.started_order > failure.started_order &&
      Number.isSafeInteger(request.finished_order) && request.finished_order > failure.failed_order &&
      Number.isInteger(request.response_status) && request.response_status >= 200 && request.response_status < 300);
    if (replacement) expected.push({ request_id: failure.request_id, replacement_request_id: replacement.request_id, classification: 'superseded_management_read' });
  }
  return expected;
}

module.exports = { managementQueryCancellations };
