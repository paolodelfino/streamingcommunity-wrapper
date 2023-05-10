async function main() {
  const app = process.argv[1];
  const sc_url = process.argv[2];
  const movie = process.argv[3];

  if (!sc_url || !movie) {
    usage();
    error("parameter is missing");
  }

  if (!sc_url.startsWith("https://")) {
    examples();
    error("invalid url");
  }

  await search_movie(movie);

  function error(message) {
    console.log("Error: ");
    console.log(message);
    process.exit(1);
  }

  /**
   * @param {Headers | undefined} headers
   * @returns {string}
   */
  async function handled_get(url, headers) {
    const response = await fetch(url, {
      headers,
    }).catch((err) => {
      error(err);
      process.exit(1);
    });
    return response.text();
  }

  /**
   *
   * @param {string} url
   * @param {Headers} headers
   * @returns {string}
   */
  async function debug_get(url, headers) {
    const response = await handled_get(url, headers);
    debug(`GET request to "${url}" executed using headers: ${headers}`);
    return response;
  }

  function debug(message) {
    console.log(`[DEBUG] ${message}`);
  }

  function usage() {
    console.log("USAGE:");
    console.log(` node ${app} <streamingcommunity url> <movie name>`);
    examples();
  }

  function examples() {
    console.log("EXAMPLES:");
    console.log(
      ' node index.js "https://streamingcommunity.army" "Enola Holmes 2"'
    );
    console.log(
      ' node index.js "https://streamingcommunity.army" "Rick and Morty"'
    );
  }

  /**
   * @param {string} name
   *
   */
  async function search_movie(name) {
    const response = await debug_get(`${sc_url}/search?q=${name}`);
  }
}

main();
