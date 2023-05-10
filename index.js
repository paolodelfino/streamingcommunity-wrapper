const sc_url = process.argv[2];

if (!sc_url) {
  error("missing argument: streamingcommunity updated website url");
}

handled_get(sc_url)
  .then((response) => response.text())
  .then(console.log);

function error(message) {
  console.log("Error: ");
  console.log(message);
  process.exit(1);
}

/**
 * @param {Headers | undefined} headers
 * @returns {Promise<Response>}
 */
function get(url, headers) {
  return fetch(url, {
    headers,
  });
}

/**
 * @param {Headers | undefined} headers
 * @returns {Promise<Response>}
 */
function handled_get(url, headers) {
  return fetch(url, {
    headers,
  }).catch((err) => {
    error(err);
    process.exit(1);
  });
}
